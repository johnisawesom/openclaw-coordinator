import { InferenceClient } from '@huggingface/inference';
import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';

dotenv.config();

const hf = new InferenceClient(process.env.HF_TOKEN!);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY!,
});

const COLLECTION = 'coordinator_logs';
const SCORE_THRESHOLD = 0.65;

export interface ErrorMemory {
  timestamp: string;
  type: string;
  message: string;
  details?: Record<string, unknown>;
  fixPrUrl?: string;
  confidence?: number;
}

async function getEmbedding(text: string): Promise<number[]> {
  const result = await hf.featureExtraction({
    model: 'sentence-transformers/all-MiniLM-L6-v2',
    inputs: text,
    options: { pooling: 'mean', normalize: true },   // ← VERIFIED: forces 384 dims
  });
  const vector = Array.from(result[0] as number[]);

  console.log(`[DEBUG] Embedding length: ${vector.length}`); // will appear in Fly logs

  return vector;
}

export async function upsertPoint(memory: ErrorMemory): Promise<string> {
  const text = `${memory.type}: ${memory.message} ${JSON.stringify(memory.details || {})}`;
  const vector = await getEmbedding(text);

  const pointId = Date.now();

  await qdrant.upsert(COLLECTION, {
    points: [{
      id: pointId,
      vector: vector,   // plain array for your unnamed collection
      payload: { ...memory, timestamp: memory.timestamp || new Date().toISOString() },
    }],
  });

  return pointId.toString();
}

export async function searchSimilarLogs(query: string, limit = 5): Promise<Array<{score: number; payload: ErrorMemory}>> {
  const vector = await getEmbedding(query);

  const results = await qdrant.search(COLLECTION, {
    vector: vector,
    limit,
    score_threshold: SCORE_THRESHOLD,
    with_payload: true,
  });

  return results.map(r => ({
    score: r.score,
    payload: r.payload as unknown as ErrorMemory,
  }));
}
