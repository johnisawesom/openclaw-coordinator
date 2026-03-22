import dotenv from 'dotenv';
dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const COLLECTION = process.env.QDRANT_COLLECTION || 'coordinator_logs';
const EMBEDDER_URL = process.env.EMBEDDER_URL || '';

const DIMS = 384;

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface DiagnosisRecord {
  rootCause: string;
  confidence: number;
  affectedLines: number[];
  riskLevel: 'low' | 'medium' | 'high';
  diagnosedBy: string;
  diagnosedAt: string;
}

export interface FixAttemptRecord {
  file: string;
  line: number;
  action: 'delete_line' | 'replace_line' | 'insert_after';
  oldContent: string;
  newContent: string;
  description: string;
  generatedBy: string;
  buildPassed: boolean;
  buildAttempts: number;
}

export interface ErrorMemory {
  // IDENTIFICATION
  timestamp: string;
  ecosystemVersion: string;
  botVersion?: string;

  // ERROR CONTEXT
  type: string;
  message: string;
  stackTrace?: string;
  fileContent?: string;
  recentCommits?: CommitSummary[];

  // DIAGNOSIS
  diagnosis?: DiagnosisRecord;

  // FIX ATTEMPT
  fixAttempt?: FixAttemptRecord;

  // OUTCOME
  prUrl?: string;
  confidence?: number;
  outcomeLabel?: 'good-fix' | 'wrong-diagnosis' | 'suppressed-error' | 'correct-but-risky';
  recurredAfterFix?: boolean;
  fixHeldForDays?: number;

  // CAUSAL CHAIN
  relatedErrorIds?: string[];
  causedByFixId?: string;

  // LEGACY — backward compatibility
  details?: Record<string, unknown>;
}

export interface RecallMatch {
  id: string;
  score: number;
  memory: ErrorMemory;
  tier: 'primary' | 'ecosystem';
}

export interface CompactionRule {
  maxAgeDays: number;
  minConfidence?: number;
  action: 'delete' | 'archive';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    throw new Error(`[qdrant-logger] Qdrant ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function getEmbedding(text: string): Promise<number[]> {
  console.log('[qdrant-logger] getEmbedding: requesting embedding from embedder');
  const res = await fetch(`${EMBEDDER_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`[qdrant-logger] Embedder returned ${res.status}`);
  }
  const data = await res.json() as { vector: number[] };
  if (!Array.isArray(data.vector) || data.vector.length !== DIMS) {
    throw new Error(`[qdrant-logger] Embedding dimension mismatch: got ${data.vector?.length}`);
  }
  console.log('[qdrant-logger] getEmbedding: received valid 384-dim embedding');
  return data.vector;
}

async function ensurePayloadIndex(
  collection: string,
  field: string,
  fieldType: string = 'keyword'
): Promise<void> {
  try {
    await qdrantRequest('PUT', `/collections/${collection}/index`, {
      field_name: field,
      field_schema: fieldType,
    });
    console.log(`[qdrant-logger] ensurePayloadIndex: index on ${collection}.${field} confirmed`);
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    // Index may already exist — not an error
    console.log(`[qdrant-logger] ensurePayloadIndex: ${collection}.${field} — ${err.message.slice(0, 80)}`);
  }
}

export async function ensureCollection(name: string, dims: number = DIMS): Promise<void> {
  console.log(`[qdrant-logger] ensureCollection: checking ${name}`);
  try {
    await qdrantRequest('GET', `/collections/${name}`);
    console.log(`[qdrant-logger] ensureCollection: ${name} already exists`);
  } catch {
    console.log(`[qdrant-logger] ensureCollection: creating ${name}`);
    await qdrantRequest('PUT', `/collections/${name}`, {
      vectors: { size: dims, distance: 'Cosine' },
    });
    console.log(`[qdrant-logger] ensureCollection: ${name} created`);
  }

  // Ensure payload indexes for filterable fields
  if (name === 'coordinator_logs') {
    await ensurePayloadIndex(name, 'prUrl');
    await ensurePayloadIndex(name, 'fixAttempt.file');
    await ensurePayloadIndex(name, 'timestamp');
  }
  if (name === 'coordinator_smoke') {
    await ensurePayloadIndex(name, 'timestamp');
  }
  if (name === 'ecosystem_memory') {
    await ensurePayloadIndex(name, 'timestamp');
  }
  if (name === 'researcher_logs') {
    await ensurePayloadIndex(name, 'timestamp');
  }
}

// ── Core Operations ───────────────────────────────────────────────────────────

export async function upsertPoint(
  memory: ErrorMemory,
  targetCollection?: string
): Promise<string> {
  const collection = targetCollection || COLLECTION;
  const id = crypto.randomUUID();
  console.log(`[qdrant-logger] upsertPoint: embedding error type=${memory.type} into ${collection}`);

  const embedding = await getEmbedding(`${memory.type} ${memory.message}`);

  await qdrantRequest('PUT', `/collections/${collection}/points`, {
    points: [{ id, vector: embedding, payload: { ...memory } }],
  });

  console.log(`[qdrant-logger] upsertPoint: stored point ${id} in ${collection}`);
  return id;
}

export async function searchSimilarLogs(
  query: string,
  limit: number = 10
): Promise<RecallMatch[]> {
  console.log(`[qdrant-logger] searchSimilarLogs: querying coordinator_logs for "${query.slice(0, 60)}"`);
  const embedding = await getEmbedding(query);

  const result = await qdrantRequest('POST', `/collections/${COLLECTION}/points/search`, {
    vector: embedding,
    limit,
    with_payload: true,
  }) as { result: Array<{ id: string; score: number; payload: ErrorMemory }> };

  const matches: RecallMatch[] = result.result.map((r) => ({
    id: String(r.id),
    score: r.score,
    memory: r.payload,
    tier: 'primary' as const,
  }));

  console.log(`[qdrant-logger] searchSimilarLogs: found ${matches.length} matches`);
  return matches;
}

export async function updateConfidence(
  prUrl: string,
  confidence: number,
  outcomeLabel?: ErrorMemory['outcomeLabel']
): Promise<void> {
  console.log(`[qdrant-logger] updateConfidence: scanning for prUrl=${prUrl}`);

  const result = await qdrantRequest('POST', `/collections/${COLLECTION}/points/scroll`, {
    filter: { must: [{ key: 'prUrl', match: { value: prUrl } }] },
    limit: 10,
    with_payload: true,
  }) as { result: { points: Array<{ id: string }> } };

  const points = result.result.points;
  if (points.length === 0) {
    console.log(`[qdrant-logger] updateConfidence: no points found for prUrl=${prUrl}`);
    return;
  }

  for (const point of points) {
    const payload: Record<string, unknown> = { confidence };
    if (outcomeLabel) payload['outcomeLabel'] = outcomeLabel;

    await qdrantRequest('POST', `/collections/${COLLECTION}/points/payload`, {
      points: [point.id],
      payload,
    });
    console.log(`[qdrant-logger] updateConfidence: updated point ${point.id} confidence=${confidence}`);
  }
}

export async function updateDiagnosis(
  pointId: string,
  diagnosis: DiagnosisRecord
): Promise<void> {
  console.log(`[qdrant-logger] updateDiagnosis: updating point ${pointId}`);
  await qdrantRequest('POST', `/collections/${COLLECTION}/points/payload`, {
    points: [pointId],
    payload: { diagnosis },
  });
  console.log(`[qdrant-logger] updateDiagnosis: diagnosis stored confidence=${diagnosis.confidence}`);
}

export async function findRecentFixForFile(
  file: string,
  withinDays: number = 7
): Promise<ErrorMemory | null> {
  console.log(`[qdrant-logger] findRecentFixForFile: scanning for file=${file} within ${withinDays} days`);

  const cutoff = new Date(Date.now() - withinDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await qdrantRequest('POST', `/collections/${COLLECTION}/points/scroll`, {
    filter: {
      must: [
        { key: 'fixAttempt.file', match: { value: file } },
      ],
    },
    limit: 10,
    with_payload: true,
  }) as { result: { points: Array<{ id: string; payload: ErrorMemory }> } };

  const points = result.result.points;
  const recent = points.filter((p) => p.payload.timestamp >= cutoff);

  if (recent.length === 0) {
    console.log(`[qdrant-logger] findRecentFixForFile: no recent fixes found for ${file}`);
    return null;
  }

  recent.sort((a, b) => b.payload.timestamp.localeCompare(a.payload.timestamp));
  console.log(`[qdrant-logger] findRecentFixForFile: found ${recent.length} recent fix(es) for ${file}`);
  return recent[0].payload;
}

export async function recentSmokeExists(): Promise<boolean> {
  console.log('[qdrant-logger] recentSmokeExists: scanning coordinator_smoke');
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const result = await qdrantRequest('POST', `/collections/coordinator_smoke/points/scroll`, {
    limit: 10,
    with_payload: true,
  }) as { result: { points: Array<{ payload: { timestamp: string } }> } };

  const recent = result.result.points.filter(
    (p) => p.payload.timestamp >= oneHourAgo
  );

  console.log(`[qdrant-logger] recentSmokeExists: found ${recent.length} recent smoke entries`);
  return recent.length > 0;
}

// ── Compaction ────────────────────────────────────────────────────────────────

export async function compactCollection(
  collection: string,
  rules: CompactionRule[]
): Promise<void> {
  console.log(`[qdrant-logger] compactCollection: starting ${collection} with ${rules.length} rules`);

  const result = await qdrantRequest('POST', `/collections/${collection}/points/scroll`, {
    limit: 1000,
    with_payload: true,
  }) as { result: { points: Array<{ id: string; payload: ErrorMemory }> } };

  const points = result.result.points;
  console.log(`[qdrant-logger] compactCollection: ${points.length} points found in ${collection}`);

  const toDelete: string[] = [];

  for (const point of points) {
    for (const rule of rules) {
      const cutoff = new Date(Date.now() - rule.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const isTooOld = point.payload.timestamp < cutoff;
      const tooLowConfidence =
        rule.minConfidence !== undefined &&
        (point.payload.confidence ?? 0.5) < rule.minConfidence;

      if (isTooOld && tooLowConfidence) {
        toDelete.push(point.id);
        break;
      } else if (isTooOld && rule.minConfidence === undefined) {
        toDelete.push(point.id);
        break;
      }
    }
  }

  if (toDelete.length > 0) {
    await qdrantRequest('POST', `/collections/${collection}/points/delete`, {
      points: toDelete,
    });
    console.log(`[qdrant-logger] compactCollection: deleted ${toDelete.length} points from ${collection}`);
  } else {
    console.log(`[qdrant-logger] compactCollection: nothing to delete in ${collection}`);
  }
}

export async function compactSmokeTests(): Promise<void> {
  console.log('[qdrant-logger] compactSmokeTests: starting');
  await compactCollection('coordinator_smoke', [{ maxAgeDays: 7, action: 'delete' }]);
}

export async function compactCoordinatorLogs(): Promise<void> {
  console.log('[qdrant-logger] compactCoordinatorLogs: starting');
  await compactCollection(COLLECTION, [
    { maxAgeDays: 90, minConfidence: 0.4, action: 'delete' },
    { maxAgeDays: 180, action: 'delete' },
  ]);
}

export async function compactEcosystemMemory(): Promise<void> {
  console.log('[qdrant-logger] compactEcosystemMemory: starting');
  await compactCollection('ecosystem_memory', [
    { maxAgeDays: 90, action: 'delete' },
  ]);
}

export async function collectMemoryMetrics(): Promise<void> {
  console.log('[qdrant-logger] collectMemoryMetrics: collecting');

  const collections = [
    COLLECTION,
    'coordinator_smoke',
    'ecosystem_memory',
    'researcher_logs',
    'ecosystem_state',
    'ecosystem_reputation',
    'qa_logs',
    'coder_logs',
  ];

  const counts: Record<string, number> = {};

  for (const col of collections) {
    try {
      const result = await qdrantRequest('POST', `/collections/${col}/points/scroll`, {
        limit: 1,
        with_payload: false,
      }) as { result: { points: unknown[] } };
      counts[col] = result.result.points.length;
    } catch {
      counts[col] = -1;
    }
  }

  console.log('[qdrant-logger] collectMemoryMetrics: counts =', JSON.stringify(counts));

  const dummyVector = Array(DIMS).fill(0);
  dummyVector[0] = 0.001;

  await qdrantRequest('PUT', `/collections/coordinator_metrics/points`, {
    points: [{
      id: crypto.randomUUID(),
      vector: dummyVector,
      payload: {
        timestamp: new Date().toISOString(),
        type: 'memory_metrics',
        counts,
      },
    }],
  });

  console.log('[qdrant-logger] collectMemoryMetrics: persisted to coordinator_metrics');
}
