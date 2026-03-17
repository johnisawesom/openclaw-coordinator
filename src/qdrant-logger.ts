import { HfInference } from '@huggingface/inference';
import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';

dotenv.config();

const hf = new HfInference(process.env.HF_TOKEN);
const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
});

const COLLECTION_NAME = 'coordinator_logs';
const VECTOR_NAME = 'dense';
const DIMENSION = 384;
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
    options: { pooling: 'mean', normalize: true },
  }) as number[][];

  if (result.length !== 1 || result[0].length !== DIMENSION) {
    throw new Error(`Embedding dimension mismatch: expected ${DIMENSION}, got ${result[0]?.length}`);
  }

  return result[0];
}

export async function upsertPoint(memory: ErrorMemory): Promise<string> {
  const textForEmbedding = `${memory.type}: ${memory.message} ${JSON.stringify(memory.details || {})}`;

  const vector = await getEmbedding(textForEmbedding);

  const pointId = `log-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  await qdrant.upsert(COLLECTION_NAME, {
    points: [{
      id: pointId,
      vector: { [VECTOR_NAME]: vector },
      payload: {
        ...memory,
        timestamp: memory.timestamp || new Date().toISOString(),
      },
    }],
  });

  return pointId;
}

export async function searchSimilarLogs(
  queryMessage: string,
  limit = 5,
  minScore = SCORE_THRESHOLD
): Promise<Array<{ score: number; payload: ErrorMemory }>> {
  const queryVector = await getEmbedding(queryMessage);

  const result = await qdrant.search(COLLECTION_NAME, {
    vector: {
      name: VECTOR_NAME,
      vector: queryVector,
    },
    limit,
    score_threshold: minScore,
    with_payload: true,
  });

  return result.map(hit => ({
    score: hit.score,
    payload: hit.payload as ErrorMemory,
  }));
}

// Rate-limit wrapper for future GitHub calls (placeholder for now)
export function withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
  // TODO: implement exponential backoff when we add Octokit
  return fn();
}
