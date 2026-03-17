import { InferenceClient } from '@huggingface/inference';
import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';  // Node 20 built-in, verified

dotenv.config();

const hf = new InferenceClient(process.env.HF_TOKEN!);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY!,
});

const COLLECTION = 'coordinator_logs';
const VECTOR_NAME = 'dense';
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
  });
  return Array.from(result[0] as number[]);
}

export async function upsertPoint(memory: ErrorMemory): Promise<string> {
  const text = `${memory.type}: ${memory.message} ${JSON.stringify(memory.details || {})}`;
  const vector = await getEmbedding(text);

  const pointId = randomUUID();  // VERIFIED UUID - ends the 400 error

  await qdrant.upsert(COLLECTION, {
    points: [{
      id: pointId,
      vector: { [VECTOR_NAME]: vector },
      payload: { ...memory, timestamp: memory.timestamp || new Date().toISOString() },
    }],
  });

  return pointId;
}

export async function searchSimilarLogs(query: string, limit = 5): Promise<Array<{score: number; payload: ErrorMemory}>> {
  const vector = await getEmbedding(query);

  const results = await qdrant.search(COLLECTION, {
    vector: { name: VECTOR_NAME, vector },
    limit,
    score_threshold: SCORE_THRESHOLD,
    with_payload: true,
  });

  return results.map(r => ({
    score: r.score,
    payload: r.payload as unknown as ErrorMemory,
  }));
}
