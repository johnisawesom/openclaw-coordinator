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
const VECTOR_SIZE = 1536; // for future embeddings (OpenAI ada-002)

// ── Qdrant client singleton ───────────────────────────────────────────────────
let _qdrantClient: QdrantClient | null = null;
function getQdrantClient(): QdrantClient | null {
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url || !apiKey) return null;

  if (!_qdrantClient) {
    _qdrantClient = new QdrantClient({ url, apiKey });
  }
  return _qdrantClient;
}

// ── One-time collection bootstrap ─────────────────────────────────────────────
let _collectionBootstrapped = false;
async function bootstrapCollection(): Promise<void> {
  if (_collectionBootstrapped) return;

  const client = getQdrantClient();
  if (!client) return;

  try {
    await client.getCollection(COLLECTION_NAME);
    console.log(`[qdrant-logger] Collection '${COLLECTION_NAME}' already exists`);
  } catch (err: any) {
    if (err?.status === 404) {
      await client.createCollection(COLLECTION_NAME, {
        vectors: {
          size: VECTOR_SIZE,
          distance: "Cosine",
        },
      });
      console.log(`[qdrant-logger] Created collection '${COLLECTION_NAME}'`);
    } else {
      console.error("[qdrant-logger] Collection bootstrap failed:", err);
    }
  }

  _collectionBootstrapped = true;
}

// ── Safe ID generator ─────────────────────────────────────────────────────────
function generatePointId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

// ── Core upsert helper ────────────────────────────────────────────────────────
async function upsertPoint(payload: Record<string, unknown>): Promise<void> {
  const client = getQdrantClient();
  if (!client) return;

  await bootstrapCollection();

  const point = {
    id: generatePointId(),
    vector: null,           // explicit null — fixes VectorStruct error
    payload,
  };

  try {
    await client.upsert(COLLECTION_NAME, {
      wait: true,
      points: [point],
    });
  } catch (err) {
    console.error("[qdrant-logger] upsert failed:", err);
    // fallback handled by caller
  }
}

// ── Structured log ────────────────────────────────────────────────────────────
export async function logToQdrant(entry: StructuredLogEntry): Promise<void> {
  const payload: Record<string, unknown> = {
    log_level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    bot_name: entry.bot_name ?? (process.env.BOT_NAME || "coordinator"),
    run_id: entry.run_id ?? "",
    pr_number: entry.pr_number ?? null,
    repo: entry.repo ?? "",
    context: entry.context ?? {},
  };

  const client = getQdrantClient();
  if (!client) {
    consoleFallback(entry.level, entry.timestamp, entry.message, entry.context);
    return;
  }

  try {
    await upsertPoint(payload);
  } catch (err) {
    console.error("[qdrant-logger] logToQdrant failed:", err);
    consoleFallback(entry.level, entry.timestamp, entry.message, entry.context);
  }
}

// ── Error-memory log ──────────────────────────────────────────────────────────
export async function logErrorMemory(memory: ErrorMemory): Promise<void> {
  const payload: Record<string, unknown> = {
    log_level: "error",
    message: memory.message,
    timestamp: memory.timestamp,
    bot_name: memory.bot_name,
    stack: memory.stack ?? "",
    context: memory.context ?? {},
  };

  const client = getQdrantClient();
  if (!client) {
    console.error(`[ERROR_MEMORY] ${memory.timestamp} [${memory.bot_name}]`, memory.message);
    return;
  }

  try {
    await upsertPoint(payload);
  } catch (err) {
    console.error("[qdrant-logger] logErrorMemory upsert failed:", err);
  }
}

// ── Console fallback ──────────────────────────────────────────────────────────
function consoleFallback(
  level: LogLevel,
  ts: string,
  message: string,
  context?: Record<string, unknown>
): void {
  const prefix = `[${level.toUpperCase()}] ${ts}`;
  const ctxStr = context ? JSON.stringify(context) : "";
  if (level === "error") {
    console.error(prefix, message, ctxStr);
  } else if (level === "warn") {
    console.warn(prefix, message, ctxStr);
  } else {
    console.log(prefix, message, ctxStr);
  }
}

// ── Named logger object (consumed by other modules) ──────────────────────────
const BOT = process.env.BOT_NAME ?? "coordinator";
function ts(): string {
  return new Date().toISOString();
}

export const logger = {
  info(message: string, context?: Record<string, unknown>): Promise<void> {
    return logToQdrant({ level: "info", message, timestamp: ts(), bot_name: BOT, context });
  },
  warn(message: string, context?: Record<string, unknown>): Promise<void> {
    return logToQdrant({ level: "warn", message, timestamp: ts(), bot_name: BOT, context });
  },
  error(message: string, context?: Record<string, unknown>): Promise<void> {
    return logToQdrant({ level: "error", message, timestamp: ts(), bot_name: BOT, context });
  },
  debug(message: string, context?: Record<string, unknown>): Promise<void> {
    return logToQdrant({ level: "debug", message, timestamp: ts(), bot_name: BOT, context });
  },
};
