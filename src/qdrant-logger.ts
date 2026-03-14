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
let pointIdCounter = Date.now(); // simple monotonic counter, starts at current timestamp

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
          [VECTOR_NAME]: {
            size: VECTOR_SIZE,
            distance: "Cosine"
          }
        }
      });
      console.log("[qdrant-logger] Collection created");
    } else {
      console.error("[qdrant-logger] Collection check failed:", err.message || err);
      if (err.data) console.error("[qdrant-logger] Full error data:", JSON.stringify(err.data));
      client = null;
      return null;
    }
  }

  return client;
}

async function upsertPoint(payload: Record<string, unknown>): Promise<boolean> {
  const cl = await getClient();
  if (!cl) return false;

  const vector = new Float32Array(VECTOR_SIZE);
  vector.fill(0.0);

  // Valid point ID: unsigned integer
  const pointId = pointIdCounter++;
  console.log("[qdrant-logger] Using integer point ID:", pointId);

  try {
    await cl.upsert(COLLECTION_NAME, {
      wait: true,
      points: [{
        id: pointId,                  // number, not string
        vector: { [VECTOR_NAME]: Array.from(vector) },
        payload
      }]
    });
    console.log(`[qdrant-logger] Upsert success - id: ${pointId}`);

    // Verify
    const retrieved = await cl.retrieve(COLLECTION_NAME, {
      ids: [pointId],
      with_payload: true
    });
    if (retrieved.length > 0) {
      console.log("[qdrant-logger] VERIFY SUCCESS - point stored");
      return true;
    }

    console.error("[qdrant-logger] VERIFY FAIL - retrieve returned nothing");
    return false;
  } catch (err: any) {
    console.error("[qdrant-logger] Upsert failed. Details:");
    console.error("Message:", err.message);
    console.error("Status:", err.status);
    console.error("Response data:", err.data ? JSON.stringify(err.data) : "no data");
    console.error("Full err keys:", Object.keys(err));
    return false;
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

// Proof on startup
(async () => {
  console.log("[qdrant-logger] Module loaded - running proof with integer ID");
  await logErrorMemory({
    bot_name: "coordinator",
    timestamp: new Date().toISOString(),
    message: "PROOF v-integer-id-20260314 - this should land in Qdrant now"
  });
})();
