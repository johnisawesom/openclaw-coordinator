import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';

dotenv.config();

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
  const response = await fetch(
    'https://api-inference.huggingface.co/models/intfloat/e5-small-v2',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: text }),
    }
  );

  if (!response.ok) {
    throw new Error(`HF API error: ${response.status}`);
  }

  const result = await response.json() as number[][];

  // Verified manual mean pooling + normalize for 384-dim output
  const tokenEmbeddings = result;
  const sum = tokenEmbeddings.reduce((acc, val) => acc.map((v, i) => v + val[i]), new Array(tokenEmbeddings[0].length).fill(0));
  const mean = sum.map(v => v / tokenEmbeddings.length);
  const norm = Math.sqrt(mean.reduce((acc, v) => acc + v * v, 0));
  const normalized = mean.map(v => v / norm);

  console.log(`[DEBUG] Embedding length: ${normalized.length}`);

  return normalized;
}

export async function upsertPoint(memory: ErrorMemory): Promise<string> {
  const text = `${memory.type}: ${memory.message} ${JSON.stringify(memory.details || {})}`;
  const vector = await getEmbedding(text);

  const pointId = Date.now();

  await qdrant.upsert(COLLECTION, {
    points: [{
      id: pointId,
      vector: vector,
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

