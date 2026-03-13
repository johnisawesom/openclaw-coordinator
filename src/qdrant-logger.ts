// src/qdrant-logger.ts
import { QdrantClient } from "@qdrant/js-client-rest";

// ── Types ─────────────────────────────────────────────────────────────────────
export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  level: LogLevel;
  message: string;
  error?: Error | unknown;
  context?: Record<string, unknown>;
}

export interface QdrantLogPoint {
  timestamp: string;              // ISO
  bot_name: string;
  level: LogLevel;
  message: string;
  error_stack: string | null;
  context: Record<string, unknown>;
  // No vector for Phase 1 - we add real embedding later
  // vectorizable_text kept for future embedding
  vectorizable_text: string;
}

// ── Singleton client ──────────────────────────────────────────────────────────
let _client: QdrantClient | null = null;
function getClient(): QdrantClient {
  if (_client) return _client;

  const url = process.env["QDRANT_URL"];
  const apiKey = process.env["QDRANT_API_KEY"];
  if (!url || !apiKey) {
    throw new Error("QDRANT_URL and QDRANT_API_KEY environment variables are required");
  }

  _client = new QdrantClient({ url, apiKey });
  return _client;
}

// ── One-time collection bootstrap ─────────────────────────────────────────────
let _collectionEnsured = false;
async function bootstrapCollection(): Promise<void> {
  if (_collectionEnsured) return;

  const client = getClient();
  const collection = process.env["QDRANT_COLLECTION"] ?? "openclaw-logs";

  try {
    await client.getCollection(collection);
    console.log(`Qdrant collection '${collection}' already exists`);
  } catch (err: any) {
    if (err?.status === 404) {
      await client.createCollection(collection, {
        vectors: {
          size: 1536,           // placeholder for future embeddings
          distance: "Cosine",
        },
      });
      console.log(`Created Qdrant collection '${collection}'`);
    } else {
      throw err;
    }
  }

  _collectionEnsured = true;
}

// ── Core logger ───────────────────────────────────────────────────────────────
export async function logToQdrant(entry: LogEntry): Promise<void> {
  const botName = process.env["BOT_NAME"] ?? "openclaw-coordinator";
  const collection = process.env["QDRANT_COLLECTION"] ?? "openclaw-logs";
  const timestamp = new Date().toISOString();

  let errorStack: string | null = null;
  if (entry.error instanceof Error) {
    errorStack = entry.error.stack ?? entry.error.message;
  } else if (entry.error != null) {
    errorStack = String(entry.error);
  }

  const ctx = entry.context ?? {};
  const vectorizableText = [
    botName,
    entry.level.toUpperCase(),
    entry.message,
    JSON.stringify(ctx),
    errorStack ?? "",
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  const point: QdrantLogPoint = {
    timestamp,
    bot_name: botName,
    level: entry.level,
    message: entry.message,
    error_stack: errorStack,
    context: ctx,
    vectorizable_text: vectorizableText,
  };

  // Always console fallback first (never lose logs)
  console.log(JSON.stringify({ level: entry.level, ...point }));

  try {
    const client = getClient();
    await bootstrapCollection();  // ensure once

    // Simple incremental ID (timestamp + random to avoid collision)
    const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);

    await client.upsert(collection, {
      wait: true,
      points: [{
        id,
        // No vector for now - payload only
        payload: point as Record<string, unknown>,
      }],
    });
  } catch (qdrantErr) {
    const errMsg = qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr);
    console.error(JSON.stringify({
      timestamp,
      bot_name: botName,
      level: "error" as LogLevel,
      message: "Qdrant upsert failed - falling back to console only",
      error_stack: errMsg,
      context: { original_entry: entry },
    }));
  }
}

// ── Convenience helpers ───────────────────────────────────────────────────────
export const logger = {
  info: (message: string, context?: Record<string, unknown>) =>
    logToQdrant({ level: "info", message, context }),

  warn: (message: string, context?: Record<string, unknown>) =>
    logToQdrant({ level: "warn", message, context }),

  error: (message: string, error?: Error | unknown, context?: Record<string, unknown>) =>
    logToQdrant({ level: "error", message, error, context }),

  debug: (message: string, context?: Record<string, unknown>) =>
    logToQdrant({ level: "debug", message, context }),
};
