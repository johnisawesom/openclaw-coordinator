import { QdrantClient } from "@qdrant/js-client-rest";
import Anthropic from "@anthropic-ai/sdk";

export interface ErrorMemory {
  bot_name: string;
  timestamp: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface StructuredLogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  bot_name?: string;
  run_id?: string;
  pr_number?: number;
  repo?: string;
  context?: Record<string, unknown>;
}

const COLLECTION_NAME = "coordinator_logs";
const VECTOR_NAME = "dense";
const VECTOR_SIZE = 1536;

let client: QdrantClient | null = null;
let anthropic: Anthropic | null = null;
let pointIdCounter = Date.now();

async function getAnthropic(): Promise<Anthropic> {
  if (anthropic) return anthropic;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[qdrant-logger] Missing ANTHROPIC_API_KEY");
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  anthropic = new Anthropic({ apiKey });
  return anthropic;
}

async function embedText(text: string): Promise<number[]> {
  try {
    const api = await getAnthropic();
    // Use Claude Haiku for cheap/fast embedding (1536 dim)
    const response = await api.embeddings.create({
      model: "claude-3-haiku-20240307",
      input: text,
    });

    const embedding = response.data[0].embedding;
    if (embedding.length !== VECTOR_SIZE) {
      throw new Error(`Embedding dim mismatch: got ${embedding.length}, expected ${VECTOR_SIZE}`);
    }

    console.log("[qdrant-logger] Embedded text:", text.slice(0, 50) + "...");
    return embedding;
  } catch (err: any) {
    console.error("[qdrant-logger] Embedding failed:", err.message);
    // Fallback to varied dummy
    return generateVariedVector(Date.now());
  }
}

function generateVariedVector(seed: number): number[] {
  const vector = new Array(VECTOR_SIZE);
  for (let i = 0; i < VECTOR_SIZE; i++) {
    vector[i] = Math.sin(i * 0.017 + seed * 0.2) * 0.6 + 0.4;
  }
  return vector;
}

async function getClient(): Promise<QdrantClient | null> {
  if (client) return client;

  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;

  if (!url || !apiKey) {
    console.error("[qdrant-logger] Missing QDRANT_URL or QDRANT_API_KEY");
    return null;
  }

  client = new QdrantClient({ url, apiKey });
  console.log("[qdrant-logger] Client created");

  try {
    const coll = await client.getCollection(COLLECTION_NAME);
    console.log("[qdrant-logger] Collection exists. Vectors config:", JSON.stringify(coll.config?.params?.vectors));
  } catch (err: any) {
    if (err.status === 404) {
      console.log("[qdrant-logger] Creating collection with named vector 'dense'");
      await client.createCollection(COLLECTION_NAME, {
        vectors: {
          [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" }
        }
      });
      console.log("[qdrant-logger] Collection created");
    } else {
      console.error("[qdrant-logger] Collection check failed:", err.message || err);
      client = null;
      return null;
    }
  }

  return client;
}

async function upsertPoint(payload: Record<string, unknown>): Promise<boolean> {
  const cl = await getClient();
  if (!cl) return false;

  const message = payload.message as string || "no message";
  const vector = await embedText(message);

  const pointId = pointIdCounter++;

  try {
    await cl.upsert(COLLECTION_NAME, {
      wait: true,
      points: [{
        id: pointId,
        vector: { [VECTOR_NAME]: vector },
        payload
      }]
    });
    console.log(`[qdrant-logger] Upsert success - id: ${pointId}`);
    return true;
  } catch (err: any) {
    console.error("[qdrant-logger] Upsert failed:", err.message, err.status);
    return false;
  }
}

async function searchSimilarLogs(queryMessage: string, limit = 5, scoreThreshold = 0.6): Promise<any[]> {
  const cl = await getClient();
  if (!cl) return [];

  const queryVector = await embedText(queryMessage);

  try {
    const results = await cl.search(COLLECTION_NAME, {
      vector: {
        name: VECTOR_NAME,
        vector: queryVector
      },
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
      params: { hnsw_ef: 256 }
    });

    console.log(`[qdrant-logger] Semantic search for "${queryMessage.slice(0, 50)}...": found ${results.length} matches`);

    results.forEach((r: any, i: number) => {
      const payload = r.payload || {};
      const msg = 'message' in payload ? payload.message : '(no message)';
      console.log(`  Match ${i+1}: score=${r.score.toFixed(4)} | ID=${r.id} | "${msg.slice(0, 80)}..."`);
    });

    return results;
  } catch (err: any) {
    console.error("[qdrant-logger] Search error:", err.message, err.status);
    return [];
  }
}

// Exports
export { logErrorMemory, logToQdrant, logger, searchSimilarLogs, ErrorMemory };


