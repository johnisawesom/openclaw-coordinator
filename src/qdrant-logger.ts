import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
dotenv.config();

const qdrantClient = new QdrantClient({
  url: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY!,
});

const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'coordinator_logs';
const SMOKE_COLLECTION = 'coordinator_smoke';
const EMBEDDER_URL = process.env.EMBEDDER_URL!;

export interface ErrorMemory {
  timestamp: string;
  type: string;
  message: string;
  details?: Record<string, unknown>;
  fixPrUrl?: string;
  confidence?: number;
  ecosystemVersion?: string;
}

export interface RecallMatch {
  score: number;
  tier: 1 | 2;
  payload: ErrorMemory;
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

export async function upsertPoint(
  memory: ErrorMemory,
  targetCollection?: string
): Promise<string> {
  const collection = targetCollection ?? COLLECTION_NAME;
  const text = `${memory.type}: ${memory.message} ${JSON.stringify(memory.details || {})}`;
  const vector = await getEmbedding(text);
  const pointId = Date.now();
  await qdrantClient.upsert(collection, {
    points: [{
      id: pointId,
      vector,
      payload: {
        ...memory,
        timestamp: memory.timestamp || new Date().toISOString(),
        confidence: memory.confidence ?? 0.5,
        ecosystemVersion: memory.ecosystemVersion ?? process.env.ECOSYSTEM_VERSION ?? '1.0',
      },
    }],
  });
  console.log(`[SUCCESS] upsertPoint id=${pointId} collection=${collection}`);
  return pointId.toString();
}

export async function searchSimilarLogs(query: string, limit = 10): Promise<RecallMatch[]> {
  const vector = await getEmbedding(query);
  const results = await qdrantClient.search(COLLECTION_NAME, {
    vector,
    limit,
    score_threshold: 0.65,
    with_payload: true,
  });

  const matches: RecallMatch[] = results.map(r => {
    const payload = r.payload as unknown as ErrorMemory;
    const confidence = payload.confidence ?? 0.5;
    const tier: 1 | 2 = confidence >= 1.0 ? 1 : 2;
    return { score: r.score, tier, payload };
  });

  const tier1 = matches.filter(m => m.tier === 1);
  const tier2 = matches.filter(m => m.tier === 2 && m.payload.confidence !== 0.0);

  console.log(`[Recall] Raw matches: ${results.length} — tier1(validated): ${tier1.length} tier2(unvalidated): ${tier2.length}`);
  return matches;
}

export async function updateConfidence(prUrl: string, confidence: number): Promise<void> {
  console.log(`[Confidence] Updating prUrl=${prUrl} to confidence=${confidence}`);
  let offset: number | undefined = undefined;
  let updated = 0;

  while (true) {
    const response = await qdrantClient.scroll(COLLECTION_NAME, {
      filter: {
        must: [{
          key: 'fixPrUrl',
          match: { value: prUrl },
        }],
      },
      limit: 100,
      offset,
      with_payload: false,
      with_vector: false,
    });

    for (const point of response.points) {
      await qdrantClient.setPayload(COLLECTION_NAME, {
        payload: { confidence },
        points: [point.id as number],
      });
      updated++;
      console.log(`[Confidence] Updated point id=${point.id} confidence=${confidence}`);
    }

    if (response.next_page_offset == null) break;
    offset = response.next_page_offset as number;
  }

  if (updated === 0) {
    console.warn(`[Confidence] No point found with fixPrUrl=${prUrl} — nothing updated`);
  } else {
    console.log(`[Confidence] Done — updated ${updated} point(s)`);
  }
}

export async function compactSmokeTests(): Promise<{ deleted: number; kept: number }> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[Compact] Scanning coordinator_smoke for entries older than ${cutoff}`);
  const toDelete: number[] = [];
  let kept = 0;
  let offset: number | undefined = undefined;

  while (true) {
    const response = await qdrantClient.scroll(SMOKE_COLLECTION, {
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

    if (response.next_page_offset == null) break;
    offset = response.next_page_offset as number;
  }

  if (toDelete.length > 0) {
    await qdrantClient.delete(SMOKE_COLLECTION, { points: toDelete });
    console.log(`[Compact] Deleted ${toDelete.length} old smoke points`);
  } else {
    console.log('[Compact] No old smoke points to delete');
  }

  console.log(`[Compact] Done — deleted: ${toDelete.length}, kept: ${kept}`);
  return { deleted: toDelete.length, kept };
}
