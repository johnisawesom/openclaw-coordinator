// src/qdrant-logger.ts
import { QdrantClient } from "@qdrant/js-client-rest";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ErrorMemory {
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

// ── Constants ─────────────────────────────────────────────────────────────────
const COLLECTION_NAME = "coordinator_logs";
const VECTOR_NAME = "dense";
const VECTOR_SIZE = 1536;

// ── State ─────────────────────────────────────────────────────────────────────
let _client: QdrantClient | null = null;
let _pointIdCounter = Date.now();

// ── Vector generation (normalized for better recall) ───────────────────────────
function generateVariedVector(seed: string): number[] {
  const normalized = seed
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const vec: number[] = new Array(VECTOR_SIZE).fill(0);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < VECTOR_SIZE; i++) {
    hash = (hash * 1664525 + 1013904223) >>> 0;
    vec[i] = ((hash & 0xffff) / 0xffff) * 2 - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// ── Qdrant client singleton ───────────────────────────────────────────────────
async function getClient(): Promise<QdrantClient | null> {
  if (_client) return _client;
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url || !apiKey) {
    console.error("[qdrant-logger] Missing QDRANT_URL or QDRANT_API_KEY");
    return null;
  }
  _client = new QdrantClient({ url, apiKey });
  console.log("[qdrant-logger] Client created");
  try {
    const coll = await _client.getCollection(COLLECTION_NAME);
    console.log(
      "[qdrant-logger] Collection exists. Vectors config:",
      JSON.stringify(coll.config?.params?.vectors)
    );
  } catch (err: unknown) {
    const status = (err as any)?.status;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 404) {
      console.log("[qdrant-logger] Creating collection with named vector 'dense'");
      await _client.createCollection(COLLECTION_NAME, {
        vectors: {
          [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" },
        },
      });
      console.log("[qdrant-logger] Collection created");
    } else {
      console.error("[qdrant-logger] Collection check failed:", message);
      _client = null;
      return null;
    }
  }
  return _client;
}

// ── Core upsert ───────────────────────────────────────────────────────────────
async function upsertPoint(payload: Record<string, unknown>): Promise<boolean> {
  const cl = await getClient();
  if (!cl) return false;
  const seed = (payload["message"] as string) || String(_pointIdCounter);
  const vector = generateVariedVector(seed);
  const pointId = _pointIdCounter++;
  try {
    await cl.upsert(COLLECTION_NAME, {
      wait: true,
      points: [
        {
          id: pointId,
          vector: { [VECTOR_NAME]: vector },
          payload,
        },
      ],
    });
    console.log(`[qdrant-logger] Upsert success - id: ${pointId}`);
    return true;
  } catch (err: unknown) {
    const status = (err as any)?.status;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[qdrant-logger] Upsert failed:", message, status);
    return false;
  }
}

// ── Semantic search ───────────────────────────────────────────────────────────
async function searchSimilarLogs(
  queryMessage: string,
  limit = 5,
  scoreThreshold = 0.45
): Promise<unknown[]> {
  const cl = await getClient();
  if (!cl) return [];
  const queryVector = generateVariedVector(queryMessage);
  try {
    const results = await cl.search(COLLECTION_NAME, {
      vector: { name: VECTOR_NAME, vector: queryVector },
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
      params: { hnsw_ef: 256 },
    });
    console.log(
      `[qdrant-logger] Semantic search for "${queryMessage.slice(0, 50)}...": ${results.length} matches`
    );
    results.forEach((r: any, i: number) => {
      const p = r.payload ?? {};
      const msg = "message" in p ? String(p["message"]) : "(no message)";
      console.log(
        ` Match ${i + 1}: score=${r.score.toFixed(4)} | ID=${r.id} | "${msg.slice(0, 80)}..."`
      );
    });
    return results;
  } catch (err: unknown) {
    const status = (err as any)?.status;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[qdrant-logger] Search error:", message, status);
    return [];
  }
}

// ── Public logging functions ──────────────────────────────────────────────────
async function logErrorMemory(memory: ErrorMemory): Promise<void> {
  const payload: Record<string, unknown> = {
    level: "error",
    message: memory.message,
    timestamp: memory.timestamp,
    bot_name: memory.bot_name,
    stack: memory.stack ?? "",
    context: memory.context ?? {},
  };
  await upsertPoint(payload);
}

async function logToQdrant(entry: StructuredLogEntry): Promise<void> {
  const payload: Record<string, unknown> = {
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    bot_name: entry.bot_name ?? process.env["BOT_NAME"] ?? "coordinator",
    run_id: entry.run_id ?? "",
    pr_number: entry.pr_number ?? null,
    repo: entry.repo ?? "",
    context: entry.context ?? {},
  };
  const success = await upsertPoint(payload);
  if (!success) {
    console.log(`[${entry.level.toUpperCase()}] ${entry.message} (Qdrant unavailable)`);
  }
}

const logger = {
  info(msg: string, ctx?: Record<string, unknown>): Promise<void> {
    return logToQdrant({ level: "info", message: msg, timestamp: new Date().toISOString(), context: ctx });
  },
  warn(msg: string, ctx?: Record<string, unknown>): Promise<void> {
    return logToQdrant({ level: "warn", message: msg, timestamp: new Date().toISOString(), context: ctx });
  },
  error(msg: string, ctx?: Record<string, unknown>): Promise<void> {
    return logToQdrant({ level: "error", message: msg, timestamp: new Date().toISOString(), context: ctx });
  },
  debug(msg: string, ctx?: Record<string, unknown>): Promise<void> {
    return logToQdrant({ level: "debug", message: msg, timestamp: new Date().toISOString(), context: ctx });
  },
};

// ── Single clean export block ─────────────────────────────────────────────────
export {
  logErrorMemory,
  logToQdrant,
  logger,
  searchSimilarLogs,
};

export type { ErrorMemory };
