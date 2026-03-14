import { QdrantClient } from "@qdrant/js-client-rest";

// ── Types (unchanged) ─────────────────────────────────────────────────────
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

// ── Constants ─────────────────────────────────────────────────────────────
const COLLECTION_NAME = "coordinator_logs";
const VECTOR_SIZE = 1536;
const VECTOR_NAME = "dense";
const PROOF_MARKER = "QDRANT_LOGGER_v20260314-02_PROOF";

// ── Singleton + bootstrap with full diagnostics ───────────────────────────
let _client: QdrantClient | null = null;
let _vectorFormat: "named" | "plain" = "named"; // default to your dashboard

async function getClient(): Promise<QdrantClient | null> {
  if (_client) return _client;

  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  if (!url || !apiKey) {
    console.error("[qdrant-logger] CRITICAL: Missing QDRANT_URL or QDRANT_API_KEY");
    return null;
  }

  try {
    _client = new QdrantClient({ url, apiKey });
    console.log(`[qdrant-logger] Client initialized (v20260314-02)`);

    // Inspect real collection
    let collectionInfo;
    try {
      collectionInfo = await _client.getCollection(COLLECTION_NAME);
      console.log("[qdrant-logger] Collection exists. Config:", JSON.stringify(collectionInfo.config?.params?.vectors));
      // Auto-detect format
      if (collectionInfo.config?.params?.vectors && typeof collectionInfo.config.params.vectors === "object" && VECTOR_NAME in collectionInfo.config.params.vectors) {
        _vectorFormat = "named";
      } else {
        _vectorFormat = "plain";
      }
    } catch (err: any) {
      if (err?.status === 404) {
        console.log(`[qdrant-logger] Collection missing → creating with NAMED "${VECTOR_NAME}"`);
        await _client.createCollection(COLLECTION_NAME, {
          vectors: {
            [VECTOR_NAME]: { size: VECTOR_SIZE, distance: "Cosine" },
          },
        });
        _vectorFormat = "named";
        console.log("[qdrant-logger] Collection created (named mode)");
      } else {
        console.error("[qdrant-logger] Collection check failed:", err.message || err);
        return null;
      }
    }

    return _client;
  } catch (err: any) {
    console.error("[qdrant-logger] Client creation FAILED:", err.message || err);
    return null;
  }
}

// ── Safe ID ───────────────────────────────────────────────────────────────
function getId(): string {
  return `proof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ── Upsert + VERIFY (the part that proves it works) ───────────────────────
async function upsert(payload: Record<string, unknown>): Promise<boolean> {
  const client = await getClient();
  if (!client) {
    console.warn("[qdrant-logger] No client — skipping");
    return false;
  }

  const dummyVector = new Array(VECTOR_SIZE).fill(0.0);
  const pointId = getId();

  const vectorPayload = _vectorFormat === "named"
    ? { [VECTOR_NAME]: dummyVector }
    : dummyVector;

  try {
    await client.upsert(COLLECTION_NAME, {
      wait: true,
      points: [{
        id: pointId,
        vector: vectorPayload,
        payload: { ...payload, proof_marker: PROOF_MARKER },
      }],
    });
    console.log(`[qdrant-logger] Upsert OK (ID: ${pointId}, format: ${_vectorFormat})`);

    // PROOF: immediately retrieve it
    const retrieved = await client.retrieve(COLLECTION_NAME, { ids: [pointId] });
    if (retrieved.length > 0) {
      console.log(`[qdrant-logger] VERIFY SUCCESS — point IS in Qdrant (ID: ${pointId})`);
      return true;
    } else {
      console.error(`[qdrant-logger] VERIFY FAILED — upsert claimed success but retrieve returned nothing`);
      return false;
    }
  } catch (err: any) {
    console.error("[qdrant-logger] Upsert FAILED:", err.message || err, "status:", err.status);
    return false;
  }
}

// ── Rest of functions (logToQdrant, logErrorMemory, logger) unchanged except extra proof logging
export async function logToQdrant(entry: StructuredLogEntry): Promise<void> {
  const payload = { /* same as before */ ... };
  const success = await upsert(payload);
  if (!success) console.log(`[${entry.level.toUpperCase()}] FALLBACK: ${entry.message}`);
}

export async function logErrorMemory(memory: ErrorMemory): Promise<void> {
  const payload = { /* same as before */ ... };
  await upsert(payload);
}

export const logger = { /* same as before */ };
