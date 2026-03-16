// @ts-ignore - no types for @xenova/transformers (JS-only package)
import { pipeline } from "@xenova/transformers";
import { QdrantClient } from "@qdrant/js-client-rest";

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
let embedder: any = null;
let pointIdCounter = Date.now();

async function getEmbedder() {
  if (embedder) return embedder;

  console.log("[qdrant-logger] Loading embedding model...");
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  console.log("[qdrant-logger] Embedding model loaded");
  return embedder;
}

async function embedText(text: string): Promise<number[]> {
  try {
    const model = await getEmbedder();
    const output = await model(text, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data as Float32Array);

    while (embedding.length < VECTOR_SIZE) {
      embedding.push(0);
    }

    console.log("[qdrant-logger] Embedded:", text.slice(0, 50) + "...");
    return embedding;
  } catch (err: any) {
    console.error("[qdrant-logger] Embedding failed:", err.message);
    return new Array(VECTOR_SIZE).fill(0);
  }
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

  const message = (payload.message as string) || "no message";
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

    console.log(`[qdrant-logger] Semantic search for "${queryMessage.slice(0, 50)}...": ${results.length} matches`);

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

// Explicit exports - NO duplicate ErrorMemory
export async function logErrorMemory(memory: ErrorMemory): Promise<void> {
  const payload = {
    level: "error",
    message: memory.message,
    timestamp: memory.timestamp,
    bot_name: memory.bot_name,
    stack: memory.stack ?? "",
    context: memory.context ?? {}
  };
  await upsertPoint(payload);
}

export async function logToQdrant(entry: StructuredLogEntry): Promise<void> {
  const payload = {
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    bot_name: entry.bot_name ?? (process.env.BOT_NAME || "coordinator"),
    run_id: entry.run_id ?? "",
    pr_number: entry.pr_number ?? null,
    repo: entry.repo ?? "",
    context: entry.context ?? {}
  };
  const success = await upsertPoint(payload);
  if (!success) {
    console.log(`[${entry.level.toUpperCase()}] ${entry.message} (Qdrant failed)`);
  }
}

export const logger = {
  info: (msg: string, ctx?: Record<string, unknown>) =>
    logToQdrant({ level: "info", message: msg, timestamp: new Date().toISOString(), context: ctx }),

  warn: (msg: string, ctx?: Record<string, unknown>) =>
    logToQdrant({ level: "warn", message: msg, timestamp: new Date().toISOString(), context: ctx }),

  error: (msg: string, ctx?: Record<string, unknown>) =>
    logToQdrant({ level: "error", message: msg, timestamp: new Date().toISOString(), context: ctx }),

  debug: (msg: string, ctx?: Record<string, unknown>) =>
    logToQdrant({ level: "debug", message: msg, timestamp: new Date().toISOString(), context: ctx })
};

export { searchSimilarLogs };
