### `src/qdrant-logger.ts` — embedder version

```typescript
// src/qdrant-logger.ts
import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';

dotenv.config();

const qdrantClient = new QdrantClient({
  url: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY!,
});

const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'coordinator_logs';
const EMBEDDER_URL = process.env.EMBEDDER_URL!;

export interface ErrorMemory {
  timestamp: string;
  type: string;
  message: string;
  details?: Record<string, unknown>;
  fixPrUrl?: string;
  confidence?: number;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${EMBEDDER_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedder returned ${response.status}: ${body}`);
  }

  const result = await response.json() as { vector: number[] };

  if (!Array.isArray(result.vector) || result.vector.length !== 384) {
    throw new Error(`Embedder returned invalid vector length: ${result.vector?.length}`);
  }

  console.log(`[DEBUG] Embedding length: ${result.vector.length}`);
  return result.vector;
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
```
