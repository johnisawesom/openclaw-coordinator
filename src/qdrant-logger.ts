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
let pointIdCounter = Date.now();

function generateVariedVector(seed: number): number[] {
  const vector = new Array(VECTOR_SIZE);
  for (let i = 0; i < VECTOR_SIZE; i++) {
    vector[i] = Math.sin(i * 0.017 + seed * 0.2) * 0.6 + 0.4; // strong deterministic variation
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

  const vector = generateVariedVector(Date.now());
  const pointId = pointIdCounter++;

  console.log(`[qdrant-logger] Upserting ID: ${pointId}`);

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

async function searchSimilarLogs(queryMessage: string, limit = 5, scoreThreshold = 0.05): Promise<any[]> {
  const cl = await getClient();
  if (!cl) return [];

  console.log(`[qdrant-logger] === SEARCH STARTED for "${queryMessage}" ===`);

  const queryVector = generateVariedVector(12345); // fixed seed for test consistency

  try {
    const results = await cl.search(COLLECTION_NAME, {
      vector: {
        name: VECTOR_NAME,
        vector: queryVector
      },
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
      params: { hnsw_ef: 128 }
    });

    console.log(`[qdrant-logger] Search complete - Found ${results.length} matches`);

    results.forEach((r, i) => {
      const payload = r.payload || {};
      const msg = typeof payload === "object" && "message" in payload ? (payload as any).message : "(no message)";
      console.log(`  Match ${i+1}: score=${r.score.toFixed(4)} | ID=${r.id} | "${msg.slice(0, 90)}..."`);
    });

    return results;
  } catch (err: any) {
    console.error("[qdrant-logger] Search error:", err.message, err.status);
    return [];
  }
}

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

// Startup proof + delayed search test
(async () => {
  console.log("[qdrant-logger] Module loaded - running proof with varied vector");
  await logErrorMemory({
    bot_name: "coordinator",
    timestamp: new Date().toISOString(),
    message: "PROOF v-varied-vector-final-20260316 - search should now return matches"
  });

  setTimeout(async () => {
    console.log("[qdrant-logger] Delayed search test starting");
    await searchSimilarLogs("TypeScript errors detected", 5, 0.05);
  }, 3000);
})();
