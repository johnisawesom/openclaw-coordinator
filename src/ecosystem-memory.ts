import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTION = 'ecosystem_memory';
const EMBEDDER_URL = process.env.EMBEDDER_URL!;

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? '',
  apiKey: process.env.QDRANT_API_KEY ?? '',
});

async function getEmbedding(text: string): Promise<number[]> {
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
  return result.vector;
}

export interface EcosystemEntry {
  bot: 'researcher' | 'coordinator' | 'qa' | 'coder';
  type: string;
  title: string;
  content: string;
  url?: string;
  timestamp: string;
  ecosystemVersion?: string;
  metadata?: Record<string, unknown>;
}

export async function writeToEcosystem(entry: EcosystemEntry): Promise<void> {
  const text = `${entry.title} ${entry.content}`;
  let vector: number[];
  try {
    vector = await getEmbedding(text);
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.warn(`[Ecosystem] Embedding failed — skipping write: ${e.message}`);
    return;
  }

  const id = Date.now();
  await qdrant.upsert(COLLECTION, {
    points: [{
      id,
      vector,
      payload: {
        ...entry,
        timestamp: entry.timestamp || new Date().toISOString(),
        ecosystemVersion: entry.ecosystemVersion ?? process.env.ECOSYSTEM_VERSION ?? '1.0',
      },
    }],
  });
  console.log(`[Ecosystem] Written — bot=${entry.bot} type=${entry.type} version=${process.env.ECOSYSTEM_VERSION ?? '1.0'} title="${entry.title.slice(0, 60)}"`);
}

export async function searchEcosystem(query: string, limit = 3): Promise<EcosystemEntry[]> {
  let vector: number[];
  try {
    vector = await getEmbedding(query);
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.warn(`[Ecosystem] Search embedding failed — returning empty: ${e.message}`);
    return [];
  }

  try {
    const results = await qdrant.search(COLLECTION, {
      vector,
      limit,
      score_threshold: 0.65,
      with_payload: true,
    });
    console.log(`[Ecosystem] Search found ${results.length} cross-bot matches`);
    return results.map(r => r.payload as unknown as EcosystemEntry);
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.warn(`[Ecosystem] Search failed — returning empty: ${e.message}`);
    return [];
  }
}
