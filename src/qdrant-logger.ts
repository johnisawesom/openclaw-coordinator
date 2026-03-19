// src/qdrant-logger.ts
// FINAL FIX — 2GB + offline xenova non-quantized singleton — full 384 semantic recall
import { pipeline } from '@xenova/transformers';
import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';

dotenv.config();

let embeddingPipeline: any = null;

const qdrantClient = new QdrantClient({
  url: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY!,
});

const COLLECTION_NAME = 'coordinator_logs';

async function getPipeline() {
  if (!embeddingPipeline) {
    console.log('[INFO] Loading embedding model (first boot only — 2GB required)');
    embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('[INFO] Model loaded successfully');
  }
  return embeddingPipeline;
}

export interface ErrorMemory {
  timestamp: string;
  type: string;
  message: string;
  details?: Record<string, unknown>;
  fixPrUrl?: string;
  confidence?: number;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const output = await pipe(text, {
    pooling: 'mean',
    normalize: true
  });
  const embedding = Array.from(output.data) as number[];
  console.log(`[DEBUG] Embedding length: ${embedding.length}`);
  if (embedding.length !== 384) {
    throw new Error(`Vector dimension error: expected 384, got ${embedding.length}`);
  }
  return embedding;
}

export async function upsertPoint(memory: ErrorMemory): Promise<string> {
  const text = `${memory.type}: ${memory.message} ${JSON.stringify(memory.details || {})}`;
  const vector = await getEmbedding(text);
  const pointId = Date.now();
  await qdrantClient.upsert(COLLECTION_NAME, {
    points: [{
      id: pointId,
      vector,
      payload: { ...memory, timestamp: memory.timestamp || new Date().toISOString() }
    }]
  });
  console.log(`[SUCCESS] upsertPoint id=${pointId}`);
  return pointId.toString();
}

export async function searchSimilarLogs(query: string, limit = 5) {
  const vector = await getEmbedding(query);
  const results = await qdrantClient.search(COLLECTION_NAME, {
    vector,
    limit,
    score_threshold: 0.65,
    with_payload: true
  });
  console.log(`[SUCCESS] searchSimilarLogs — found ${results.length} matches (score > 0.65)`);
  return results.map(r => ({
    score: r.score,
    payload: r.payload as unknown as ErrorMemory
  }));
}

export async function compactSmokeTests(): Promise<{ deleted: number; kept: number }> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[Compact] Scanning for SmokeTest entries older than ${cutoff}`);

  const toDelete: number[] = [];
  let kept = 0;
  let offset: number | undefined = undefined;

  while (true) {
    const response = await qdrantClient.scroll(COLLECTION_NAME, {
      filter: {
        must: [
          {
            key: 'type',
            match: { value: 'SmokeTest' },
          },
        ],
      },
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false,
    });

    for (const point of response.points) {
      const payload = point.payload as unknown as ErrorMemory;
      if (payload.timestamp < cutoff) {
        toDelete.push(point.id as number);
      } else {
        kept++;
      }
    }

    if (response.next_page_offset == null) {
      break;
    }
    offset = response.next_page_offset as number;
  }

  if (toDelete.length > 0) {
    await qdrantClient.delete(COLLECTION_NAME, {
      points: toDelete,
    });
    console.log(`[Compact] Deleted ${toDelete.length} old SmokeTest points`);
  } else {
    console.log('[Compact] No old SmokeTest points to delete');
  }

  console.log(`[Compact] Done — deleted: ${toDelete.length}, kept: ${kept}`);
  return { deleted: toDelete.length, kept };
}
