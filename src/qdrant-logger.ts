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

// ── Qdrant client singleton ───────────────────────────────────────────────────

const COLLECTION_NAME = "coordinator_logs";

let _qdrantClient: QdrantClient | null = null;

function getQdrantClient(): QdrantClient | null {
  const url = process.env.QDRANT_URL;
  if (!url) return null;
  if (!_qdrantClient) {
    _qdrantClient = new QdrantClient({ url, apiKey: process.env.QDRANT_API_KEY });
  }
  return _qdrantClient;
}

// ── ID counter ────────────────────────────────────────────────────────────────

let _idCounter = Date.now();
function nextId(): number {
  return _idCounter++;
}

// ── Core upsert helper ────────────────────────────────────────────────────────

async function upsertPoint(payload: Record<string, unknown>): Promise<void> {
  const client = getQdrantClient();
  if (!client) return; // console fallback handled by callers

  const point = {
    id: nextId(),
    vector: null as any,
    payload,
  };

  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: [point as any],
  });
}

// ── Structured log ────────────────────────────────────────────────────────────

export async function logToQdrant(entry: StructuredLogEntry): Promise<void> {
  const payload: Record<string, unknown> = {
    log_level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    bot_name: entry.bot_name ?? "coordinator",
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
    console.error("[qdrant-logger] upsert failed:", err);
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
  if (level === "error") {
    console.error(prefix, message, context ?? "");
  } else if (level === "warn") {
    console.warn(prefix, message, context ?? "");
  } else {
    console.log(prefix, message, context ?? "");
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
