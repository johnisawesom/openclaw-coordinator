// src/qdrant-logger.ts
import { QdrantClient } from "@qdrant/js-client-rest";

// ── Types ─────────────────────────────────────────────────────────────────────
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

// ── Constants ─────────────────────────────────────────────────────────────────
const COLLECTION_NAME = "coordinator_logs";
const VECTOR_SIZE = 1536; // placeholder for future

// ── Singleton + bootstrap ─────────────────────────────────────────────────────
let _client: QdrantClient | null = null;
let _bootstrapped = false;

async function getClient(): Promise<QdrantClient> {
  if (_client) return _client;

  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url || !apiKey) {
    throw new Error("Missing QDRANT_URL or QDRANT_API_KEY");
  }

  _client = new QdrantClient({ url, apiKey });

  // Bootstrap once
  if (!_bootstrapped) {
    try {
      await _client.getCollection(COLLECTION_NAME);
    } catch (err: any) {
      if (err?.status === 404) {
        await _client.createCollection(COLLECTION_NAME, {
          vectors: { size: VECTOR_SIZE, distance: "Cosine" },
        });
      } else {
        throw err;
      }
    }
    _bootstrapped = true;
  }

  return _client;
}

// ── Safe ID ───────────────────────────────────────────────────────────────────
function getId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

// ── Upsert helper ─────────────────────────────────────────────────────────────
async function upsert(payload: Record<string, unknown>): Promise<void> {
  const client = await getClient().catch(err => {
    console.error("[qdrant] Client init failed:", err);
    return null;
  });
  if (!client) return;

  try {
    await client.upsert(COLLECTION_NAME, {
      wait: true,
      points: [{
        id: getId(),
        vector: null,  // explicit null — fixes VectorStruct error
        payload,
      }],
    });
  } catch (err) {
    console.error("[qdrant-logger] upsert failed:", err);
  }
}

// ── Structured log ────────────────────────────────────────────────────────────
export async function logToQdrant(entry: StructuredLogEntry): Promise<void> {
  const payload = {
    log_level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    bot_name: entry.bot_name ?? (process.env.BOT_NAME || "coordinator"),
    run_id: entry.run_id ?? "",
    pr_number: entry.pr_number ?? null,
    repo: entry.repo ?? "",
    context: entry.context ?? {},
  };

  await upsert(payload).catch(() => {
    // fallback console
    console.log(`[${entry.level.toUpperCase()}] ${entry.timestamp} ${entry.message}`, entry.context ?? "");
  });
}

// ── Error memory log ──────────────────────────────────────────────────────────
export async function logErrorMemory(memory: ErrorMemory): Promise<void> {
  const payload = {
    log_level: "error",
    message: memory.message,
    timestamp: memory.timestamp,
    bot_name: memory.bot_name,
    stack: memory.stack ?? "",
    context: memory.context ?? {},
  };

  await upsert(payload);
}

// ── Logger object ─────────────────────────────────────────────────────────────
export const logger = {
  info: (msg: string, ctx?: Record<string, unknown>) => logToQdrant({ level: "info", message: msg, timestamp: new Date().toISOString(), context: ctx }),
  warn: (msg: string, ctx?: Record<string, unknown>) => logToQdrant({ level: "warn", message: msg, timestamp: new Date().toISOString(), context: ctx }),
  error: (msg: string, ctx?: Record<string, unknown>) => logToQdrant({ level: "error", message: msg, timestamp: new Date().toISOString(), context: ctx }),
  debug: (msg: string, ctx?: Record<string, unknown>) => logToQdrant({ level: "debug", message: msg, timestamp: new Date().toISOString(), context: ctx }),
};
