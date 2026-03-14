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
    await client.getCollection(COLLECTION_NAME);
    console.log("[qdrant-logger] Collection exists");
  } catch (err: any) {
    if (err.status === 404) {
      console.log("[qdrant-logger] Creating collection");
      await client.createCollection(COLLECTION_NAME, {
        vectors: {
          [VECTOR_NAME]: {
            size: VECTOR_SIZE,
            distance: "Cosine"
          }
        }
      });
      console.log("[qdrant-logger] Collection created");
    } else {
      console.error("[qdrant-logger] Collection check failed:", err.message);
      client = null;
      return null;
    }
  }

  return client;
}

async function upsertPoint(payload: Record<string, unknown>): Promise<boolean> {
  const cl = await getClient();
  if (!cl) return false;

  const vector = new Array(VECTOR_SIZE).fill(0);
  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  try {
    await cl.upsert(COLLECTION_NAME, {
      wait: true,
      points: [{
        id,
        vector: { [VECTOR_NAME]: vector },
        payload
      }]
    });
    console.log("[qdrant-logger] Upsert OK id:", id);

    const res = await cl.retrieve(COLLECTION_NAME, { ids: [id] });
    if (res.length > 0) {
      console.log("[qdrant-logger] VERIFY SUCCESS - point exists");
      return true;
    }
    console.error("[qdrant-logger] VERIFY FAIL - point not found after upsert");
    return false;
  } catch (err: any) {
    console.error("[qdrant-logger] Upsert failed:", err.message, err.status);
    return false;
  }
}

export async function logErrorMemory(mem: ErrorMemory): Promise<void> {
  const payload = {
    level: "error",
    message: mem.message,
    timestamp: mem.timestamp,
    bot_name: mem.bot_name,
    stack: mem.stack || "",
    context: mem.context || {}
  };
  await upsertPoint(payload);
}

export async function logToQdrant(entry: StructuredLogEntry): Promise<void> {
  const payload = {
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    bot_name: entry.bot_name || "coordinator",
    run_id: entry.run_id || "",
    pr_number: entry.pr_number || null,
    repo: entry.repo || "",
    context: entry.context || {}
  };
  const ok = await upsertPoint(payload);
  if (!ok) {
    console.log(`[${entry.level.toUpperCase()}] ${entry.message} (qdrant failed)`);
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

// Startup proof test
(async () => {
  console.log("[qdrant-logger] Startup test running");
  await logErrorMemory({
    bot_name: "coordinator",
    timestamp: new Date().toISOString(),
    message: "PROOF - qdrant logger working - check dashboard point count"
  });
})();
