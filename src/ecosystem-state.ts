import dotenv from 'dotenv';
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const STATE_COLLECTION = 'ecosystem_state';
const DIMS = 384;

export type StateKey =
  | 'coordinator_processing'
  | 'last_fix_completed'
  | 'last_fix_pr_url'
  | 'last_health_check'
  | 'embedder_status'
  | 'active_fix_file';

export interface EcosystemState {
  key: string;
  value: string;
  updatedAt: string;
  updatedBy: string;
}

async function qdrantRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${QDRANT_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'api-key': QDRANT_API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[ecosystem-state] Qdrant ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

// Each StateKey maps to a fixed UUID so upsert always overwrites the same point
const STATE_KEY_IDS: Record<StateKey, string> = {
  'coordinator_processing': '00000001-0000-0000-0000-000000000001',
  'last_fix_completed':     '00000001-0000-0000-0000-000000000002',
  'last_fix_pr_url':        '00000001-0000-0000-0000-000000000003',
  'last_health_check':      '00000001-0000-0000-0000-000000000004',
  'embedder_status':        '00000001-0000-0000-0000-000000000005',
  'active_fix_file':        '00000001-0000-0000-0000-000000000006',
};

export async function ensureStateCollection(): Promise<void> {
  console.log('[ecosystem-state] ensureStateCollection: checking ecosystem_state');
  try {
    await qdrantRequest('GET', `/collections/${STATE_COLLECTION}`);
    console.log('[ecosystem-state] ensureStateCollection: already exists');
  } catch {
    console.log('[ecosystem-state] ensureStateCollection: creating');
    await qdrantRequest('PUT', `/collections/${STATE_COLLECTION}`, {
      vectors: { size: DIMS, distance: 'Cosine' },
    });
    console.log('[ecosystem-state] ensureStateCollection: created');
  }
}

export async function setState(
  key: StateKey,
  value: string,
  updatedBy: string = 'coordinator'
): Promise<void> {
  console.log(`[ecosystem-state] setState: key=${key} value=${value} by=${updatedBy}`);

  const dummyVector = Array(DIMS).fill(0);
  dummyVector[0] = 0.001;

  const state: EcosystemState = {
    key,
    value,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  const pointId = STATE_KEY_IDS[key];

  await qdrantRequest('PUT', `/collections/${STATE_COLLECTION}/points`, {
    points: [{
      id: pointId,
      vector: dummyVector,
      payload: state,
    }],
  });

  console.log(`[ecosystem-state] setState: stored key=${key} id=${pointId}`);
}

export async function getState(key: StateKey): Promise<EcosystemState | null> {
  console.log(`[ecosystem-state] getState: key=${key}`);

  const pointId = STATE_KEY_IDS[key];

  try {
    const result = await qdrantRequest(
      'GET',
      `/collections/${STATE_COLLECTION}/points/${pointId}`
    ) as { result: { payload: EcosystemState } | null };

    if (!result.result) {
      console.log(`[ecosystem-state] getState: key=${key} not found`);
      return null;
    }

    console.log(`[ecosystem-state] getState: key=${key} value=${result.result.payload.value}`);
    return result.result.payload;

  } catch {
    console.log(`[ecosystem-state] getState: key=${key} not found or collection missing`);
    return null;
  }
}
