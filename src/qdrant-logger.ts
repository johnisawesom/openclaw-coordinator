// src/qdrant-logger.ts
import { QdrantClient } from "@qdrant/js-client-rest";

export interface QdrantLogPoint {
  id: number;
  vector: number[] | null;
  payload: Record<string, unknown> & { [key: string]: unknown };
}

export interface ErrorMemory {
  bot_name: string;
  timestamp: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

const COLLECTION_NAME = "coordinator_logs";

let qdrantClient: QdrantClient | null = null;

function getQdrantClient(): QdrantClient | null {
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;

  if (!url) {
    return null;
  }

  if (!qdrantClient) {
    qdrantClient = new QdrantClient({ url, apiKey });
  }

  return qdrantClient;
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

let logIdCounter = Date.now();

function nextId(): number {
  return logIdCounter++;
}

export async function logToQdrant(entry: StructuredLogEntry): Promise<void> {
  const client = getQdrantClient();

  const payload: Record<string, unknown> = {
    message: entry.message,
    timestamp: entry.timestamp,
    bot_name: entry.bot_name ?? "coordinator",
    run_id: entry.run_id ?? "",
    pr_number: entry.pr_number ?? null,
    repo: entry.repo ?? "",
    context: entry.context ?? {},
    log_level: entry.level,
  };

  const point: QdrantLogPoint = {
    id: nextId(),
    vector: null,
    payload,
  };

  if (!client) {
    // Console fallback when Qdrant is not configured
    const prefix = `[${entry.level.toUpperCase()}] ${entry.timestamp}`;
    if (entry.level === "error") {
      console.error(prefix, entry.message, entry.context ?? "");
    } else if (entry.level === "warn") {
      console.warn(prefix, entry.message, entry.context ?? "");
    } else {
      console.log(prefix, entry.message, entry.context ?? "");
    }
    return;
  }

  try {
    await client.upsert(COLLECTION_NAME, {
      wait: true,
      points: [point as unknown as Record<string, unknown>],
    });
  } catch (err) {
    // Fallback to console if Qdrant upsert fails
    console.error("[qdrant-logger] upsert failed, falling back to console:", err);
    console.log(`[${entry.level.toUpperCase()}] ${entry.timestamp}`, entry.message);
  }
}

export async function logErrorMemory(memory: ErrorMemory): Promise<void> {
  const payload: Record<string, unknown> = {
    log_level: "error",
    message: memory.message,
    timestamp: memory.timestamp,
    bot_name: memory.bot_name,
    stack: memory.stack ?? "",
    context: memory.context ?? {},
  };

  const point: QdrantLogPoint = {
    id: nextId(),
    vector: null,
    payload,
  };

  const client = getQdrantClient();

  if (!client) {
    console.error(`[ERROR_MEMORY] ${memory.timestamp} [${memory.bot_name}]`, memory.message);
    return;
  }

  try {
    await client.upsert(COLLECTION_NAME, {
      wait: true,
      points: [point as unknown as Record<string, unknown>],
    });
  } catch (err) {
    console.error("[qdrant-logger] logErrorMemory upsert failed:", err);
  }
}
