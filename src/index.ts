import http from 'http';
import crypto from 'crypto';
import {
  upsertPoint,
  searchSimilarLogs,
  compactSmokeTests,
  compactCoordinatorLogs,
  compactEcosystemMemory,
  collectMemoryMetrics,
  updateConfidence,
  updatePrUrl,
  recentSmokeExists,
  ensureCollection,
  updateDiagnosis,
  findRecentFixForFile,
  ErrorMemory,
  RecallMatch,
  DiagnosisRecord,
} from './qdrant-logger.js';
import { writeToEcosystem, searchEcosystem, EcosystemEntry } from './ecosystem-memory.js';
import {
  createFixPR,
  createAlertIssue,
  fetchFileFromGitHub,
  fetchRecentCommits,
  openDiagnosisIssue,
} from './github-client.js';
import { callLLM } from './llm-router.js';
import { setState, getState, ensureStateCollection } from './ecosystem-state.js';
import { COORDINATOR_CONSTITUTION } from './coordinator-constitution.js';
import dotenv from 'dotenv';
dotenv.config();
console.log('[INFO] createFixPR loaded:', typeof createFixPR);

const PORT = 8080;
const SMOKE_COLLECTION = 'coordinator_smoke';
const ECOSYSTEM_VERSION = process.env.ECOSYSTEM_VERSION || '1.0';
const BOT_VERSION = '1.9.1';

interface FixSuggestion {
  file: string;
  line: number;
  action: 'delete_line' | 'replace_line' | 'insert_after';
  newContent: string;
  description: string;
}

function parseFixSuggestion(raw: string): FixSuggestion {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const parsed: unknown = JSON.parse(cleaned);

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).file !== 'string' ||
    typeof (parsed as Record<string, unknown>).line !== 'number' ||
    typeof (parsed as Record<string, unknown>).action !== 'string' ||
    typeof (parsed as Record<string, unknown>).newContent !== 'string' ||
    typeof (parsed as Record<string, unknown>).description !== 'string'
  ) {
    throw new Error('Missing or invalid fields in LLM JSON response');
  }

  const candidate = parsed as Record<string, unknown>;

  if (
    candidate.action !== 'delete_line' &&
    candidate.action !== 'replace_line' &&
    candidate.action !== 'insert_after'
  ) {
    throw new Error(`Invalid action value: ${String(candidate.action)}`);
  }

  return {
    file: candidate.file as string,
    line: candidate.line as number,
    action: candidate.action as FixSuggestion['action'],
    newContent: candidate.newContent as string,
    description: candidate.description as string,
  };
}

async function callQABot(
  fix: FixSuggestion,
  prUrl: string
): Promise<{ status: 'PASS' | 'FAIL'; reason: string }> {
  const qaUrl = process.env.QA_BOT_URL;

  if (!qaUrl) {
    console.warn('[QA] QA_BOT_URL not set — blocking PR as safe default');
    return { status: 'FAIL', reason: 'QA_BOT_URL environment variable not set' };
  }

  console.log('[QA] Sending fix for review...');
  const timeout = setTimeout(() => controller.abort(), 10000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${qaUrl}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prUrl, fix }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const result = await response.json() as { status: 'PASS' | 'FAIL'; reason: string };
    console.log(`[QA] ${result.status} — ${result.reason}`);
    return result;

  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[QA] Request timed out after 10s — blocking PR as safe default');
      return { status: 'FAIL', reason: 'QA Bot request timed out' };
    }
    console.warn(
      `[QA] Request failed — blocking PR as safe default: ${err instanceof Error ? err.message : String(err)}`
    );
    return { status: 'FAIL', reason: 'QA Bot unreachable' };
  }
}

async function callCoderBot(fix: FixSuggestion): Promise<{ branch: string; commitSha: string }> {
  const coderUrl = process.env.CODER_BOT_URL;

  if (!coderUrl) {
    throw new Error('CODER_BOT_URL environment variable not set');
  }

  console.log('[Coder] Sending fix to Coder Bot...');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${coderUrl}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fix }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const result = await response.json() as
      | { status: 'ok'; branch: string; commitSha: string; message: string }
      | { status: 'error'; reason: string };

    if (result.status === 'error') {
      throw new Error(`Coder Bot rejected fix: ${result.reason}`);
    }

    console.log(`[Coder] Success — branch: ${result.branch}, commit: ${result.commitSha}`);
    return { branch: result.branch, commitSha: result.commitSha };

  } catch (err: unknown) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Coder Bot request timed out after 30s');
    }
    throw err;
  }
}

function buildRecallContext(
  matches: RecallMatch[],
  ecosystemMatches: EcosystemEntry[]
): {
  localContext: string;
  ecosystemContext: string;
  tier1Count: number;
  tier2Count: number;
  ecosystemCount: number;
} {
  const tier1 = matches.filter(m => m.tier === 'primary');
  const tier2 = matches.filter(
    m => m.tier === 'ecosystem' && (m.memory.confidence ?? 0.5) > 0.3
  );

  const selectedTier1 = tier1.slice(0, 3);
  const tier2Slots = Math.max(0, 2 - selectedTier1.length);
  const selectedTier2 = tier2Slots > 0 ? tier2.slice(0, tier2Slots) : [];
  const selected = [...selectedTier1, ...selectedTier2];

  const localContext = selected
    .map(m => {
      const payload = JSON.stringify(m.memory).slice(0, 200);
      const tierLabel = m.tier === 'primary' ? 'validated' : 'unvalidated';
      return `Past fix [${tierLabel}] (score ${m.score.toFixed(3)}, confidence ${(m.memory.confidence ?? 0.5).toFixed(2)}): ${payload}`;
    })
    .join('\n\n');

  const selectedEcosystem = ecosystemMatches.slice(0, 2);
  const ecosystemContext = selectedEcosystem
    .map(e => {
      const snippet = e.content.slice(0, 150);
      return `Cross-bot insight (${e.bot}): ${e.title} — ${snippet}`;
    })
    .join('\n\n');

  return {
    localContext,
    ecosystemContext,
    tier1Count: selectedTier1.length,
    tier2Count: selectedTier2.length,
    ecosystemCount: selectedEcosystem.length,
  };
}

// ── Phase 1: Enrich ───────────────────────────────────────────────────────────

async function enrichError(error: ErrorMemory): Promise<ErrorMemory> {
  console.log(`[Enrich] Phase 1: enriching error type=${error.type}`);

  const enriched: ErrorMemory = { ...error };

  if (error.details && typeof error.details['file'] === 'string') {
    const file = error.details['file'] as string;
    try {
      enriched.fileContent = await fetchFileFromGitHub(file);
      console.log(`[Enrich] Fetched file content: ${file} (${enriched.fileContent.length} chars)`);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(`[Enrich] Could not fetch file ${file}: ${err.message}`);
    }

    try {
      enriched.recentCommits = await fetchRecentCommits(file, 5);
      console.log(`[Enrich] Fetched ${enriched.recentCommits.length} recent commits for ${file}`);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(`[Enrich] Could not fetch commits for ${file}: ${err.message}`);
    }

    try {
      const recentFix = await findRecentFixForFile(file, 7);
      if (recentFix) {
        console.log(`[Enrich] Found recent fix for ${file} — possible recurrence`);
        enriched.relatedErrorIds = enriched.relatedErrorIds || [];
        if (recentFix.prUrl) {
          enriched.relatedErrorIds.push(recentFix.prUrl);
        }
        enriched.recurredAfterFix = true;
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(`[Enrich] Could not check recent fixes: ${err.message}`);
    }
  }

  console.log(`[Enrich] Phase 1 complete — fileContent=${!!enriched.fileContent} commits=${enriched.recentCommits?.length ?? 0} recurred=${enriched.recurredAfterFix ?? false}`);
  return enriched;
}

// ── Phase 2: Diagnose ─────────────────────────────────────────────────────────

async function diagnoseError(
  enriched: ErrorMemory,
  pointId: string
): Promise<DiagnosisRecord | null> {
  console.log(`[Diagnose] Phase 2: diagnosing error type=${enriched.type}`);

  const fileSection = enriched.fileContent
    ? `\nFile content snapshot:\n\`\`\`typescript\n${enriched.fileContent.slice(0, 2000)}\n\`\`\``
    : '\nNo file content available.';

  const commitsSection = enriched.recentCommits && enriched.recentCommits.length > 0
    ? `\nRecent commits:\n${enriched.recentCommits.map(c => `- ${c.sha} (${c.author}, ${c.date}): ${c.message}`).join('\n')}`
    : '\nNo recent commits available.';

  const recurrenceNote = enriched.recurredAfterFix
    ? '\nNOTE: This error has recurred after a recent fix attempt. The previous fix may have been incomplete.'
    : '';

  const diagnosisPrompt = `${COORDINATOR_CONSTITUTION}

You are diagnosing an error in the OpenClaw ecosystem.

ERROR:
Type: ${enriched.type}
Message: ${enriched.message}
Details: ${JSON.stringify(enriched.details || {})}
${fileSection}
${commitsSection}
${recurrenceNote}

Respond with ONLY a JSON object in this exact format, no other text:
{
  "rootCause": "<one sentence describing the true root cause>",
  "confidence": <number between 0.0 and 1.0>,
  "affectedLines": [<line numbers as integers>],
  "riskLevel": "low" | "medium" | "high",
  "diagnosedBy": "coordinator-llm"
}

Confidence guide:
- 0.9+ : You can see the exact broken line in the file content
- 0.7-0.9 : You understand the cause but cannot pinpoint the exact line
- 0.5-0.7 : You have a hypothesis but are not certain
- below 0.5 : You do not have enough information to diagnose`;

  let diagnosisText: string;
  try {
    const diagnosisResponse = await callLLM({
      task: 'fix_suggestion',
      prompt: diagnosisPrompt,
      systemPrompt: 'You are a senior TypeScript engineer diagnosing errors. Return ONLY valid JSON. No explanation outside the JSON.',
      maxTokens: 300,
    });
    diagnosisText = diagnosisResponse.text;
    console.log(`[Diagnose] LLM responded via ${diagnosisResponse.provider} using ${diagnosisResponse.model}`);
  } catch (llmErr: unknown) {
    const e = llmErr instanceof Error ? llmErr : new Error(String(llmErr));
    console.error(`[Diagnose] LLM call failed: ${e.message}`);
    return null;
  }

  console.log('[Diagnose] Raw diagnosis response:', diagnosisText);

  let diagnosis: DiagnosisRecord;
  try {
    const cleaned = diagnosisText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    diagnosis = {
      rootCause: String(parsed['rootCause'] ?? 'unknown'),
      confidence: Number(parsed['confidence'] ?? 0),
      affectedLines: Array.isArray(parsed['affectedLines'])
        ? (parsed['affectedLines'] as unknown[]).map(Number)
        : [],
      riskLevel: (parsed['riskLevel'] === 'low' || parsed['riskLevel'] === 'medium' || parsed['riskLevel'] === 'high')
        ? parsed['riskLevel']
        : 'medium',
      diagnosedBy: String(parsed['diagnosedBy'] ?? 'coordinator-llm'),
      diagnosedAt: new Date().toISOString(),
    };

    console.log(`[Diagnose] Parsed — confidence=${diagnosis.confidence} risk=${diagnosis.riskLevel}`);
    console.log(`[Diagnose] Root cause: ${diagnosis.rootCause}`);

  } catch (parseErr: unknown) {
    const e = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
    console.error(`[Diagnose] Failed to parse diagnosis JSON: ${e.message}`);
    return null;
  }

  try {
    await updateDiagnosis(pointId, diagnosis);
    console.log(`[Diagnose] Diagnosis stored to point ${pointId}`);
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.warn(`[Diagnose] Could not store diagnosis: ${err.message}`);
  }

  return diagnosis;
}

// ── Main error handler ────────────────────────────────────────────────────────

export async function handleError(error: ErrorMemory): Promise<void> {
  console.log(`[Decision] ========== handleError start ==========`);
  console.log(`[Decision] Error type: ${error.type}`);
  console.log(`[Decision] Error message: ${error.message}`);

  // Phase 0: Check if already processing
  try {
    const processingState = await getState('coordinator_processing');
    if (processingState && processingState.value === 'true') {
      console.warn('[Decision] Phase 0: coordinator_processing=true — skipping to avoid concurrent fixes');
      return;
    }
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.warn(`[Decision] Phase 0: could not read state — proceeding: ${err.message}`);
  }

  try {
    await setState('coordinator_processing', 'true');
    console.log('[Decision] Phase 0: coordinator_processing set to true');
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.warn(`[Decision] Phase 0: could not set state — proceeding: ${err.message}`);
  }

  try {
    const enrichedBase: ErrorMemory = {
      ...error,
      ecosystemVersion: error.ecosystemVersion || ECOSYSTEM_VERSION,
      confidence: 0.5,
    };

    const pointId = await upsertPoint(enrichedBase);
    console.log(`[Decision] Upserted to coordinator_logs — point ID: ${pointId}`);

    writeToEcosystem({
      bot: 'coordinator',
      type: enrichedBase.type,
      title: `${enrichedBase.type}: ${enrichedBase.message}`,
      content: JSON.stringify(enrichedBase.details || {}),
      timestamp: enrichedBase.timestamp || new Date().toISOString(),
      metadata: { pointId },
    }).catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Ecosystem] Write failed — not blocking handleError: ${e.message}`);
    });

    // Phase 1: Enrich
    const enriched = await enrichError(enrichedBase);

    // Phase 2: Diagnose
    const diagnosis = await diagnoseError(enriched, pointId);

    if (!diagnosis) {
      console.warn('[Decision] Phase 2: diagnosis returned null — cannot proceed to fix');
      await openDiagnosisIssue(
        enriched.type,
        enriched.message,
        0,
        'Diagnosis LLM call failed or returned unparseable response'
      ).catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        console.warn(`[Decision] Could not open diagnosis issue: ${err.message}`);
      });
      return;
    }

    console.log(`[Decision] Phase 2 complete — confidence=${diagnosis.confidence} threshold=0.7`);

    if (diagnosis.confidence < 0.7) {
      console.warn(`[Decision] Phase 2: confidence ${diagnosis.confidence} below 0.7 — opening NEEDS_DIAGNOSIS issue`);
      await openDiagnosisIssue(
        enriched.type,
        enriched.message,
        diagnosis.confidence,
        diagnosis.rootCause
      ).catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        console.warn(`[Decision] Could not open diagnosis issue: ${err.message}`);
      });
      return;
    }

    console.log('[Decision] Phase 2: confidence sufficient — proceeding to fix generation');

    // Phase 3: Generate fix
    const [matches, ecosystemMatches] = await Promise.all([
      searchSimilarLogs(enriched.message),
      searchEcosystem(enriched.message),
    ]);

    const { localContext, ecosystemContext, tier1Count, tier2Count, ecosystemCount } =
      buildRecallContext(matches, ecosystemMatches);

    console.log(`[Decision] Recall tier1(validated): ${tier1Count} tier2(unvalidated): ${tier2Count} ecosystem: ${ecosystemCount}`);

    const fileContextSection = enriched.fileContent
      ? `\nCurrent file content:\n\`\`\`typescript\n${enriched.fileContent.slice(0, 3000)}\n\`\`\``
      : '';

    const prompt = `${COORDINATOR_CONSTITUTION}

You are a senior TypeScript engineer fixing OpenClaw Coordinator.

DIAGNOSIS:
Root cause: ${diagnosis.rootCause}
Confidence: ${diagnosis.confidence}
Risk level: ${diagnosis.riskLevel}
Affected lines: ${diagnosis.affectedLines.join(', ') || 'unknown'}

Current error:
${enriched.type}: ${enriched.message}
Details: ${JSON.stringify(enriched.details)}
${fileContextSection}

Past similar fixes:
${localContext || '(none found)'}

Cross-bot ecosystem insights:
${ecosystemContext || '(none found)'}

Respond with ONLY a JSON object in this exact format, no other text:
{
  "file": "src/filename.ts",
  "line": <line number as integer>,
  "action": "delete_line" | "replace_line" | "insert_after",
  "newContent": "<the replacement or insertion content, empty string if action is delete_line>",
  "description": "<one sentence explaining the fix>"
}`;

    let llmText: string;
    try {
      const llmResponse = await callLLM({
        task: 'fix_suggestion',
        prompt,
        systemPrompt: `You are a senior TypeScript engineer fixing OpenClaw Coordinator.
Analyse the error and return ONLY valid JSON with this exact structure:
{
  "file": "src/filename.ts",
  "line": 42,
  "action": "delete_line" | "replace_line" | "insert_after",
  "newContent": "the corrected line of code",
  "description": "one sentence explaining the fix"
}
Valid actions: delete_line, replace_line, insert_after. No explanation outside the JSON.`,
        maxTokens: 200,
      });
      llmText = llmResponse.text;
      console.log(`[Decision] LLM responded via ${llmResponse.provider} using ${llmResponse.model}`);
    } catch (llmErr: unknown) {
      const e = llmErr instanceof Error ? llmErr : new Error(String(llmErr));
      if (e.message.startsWith('LLM_BOTH_FAILED')) {
        console.error(`[Decision] LLM_BOTH_FAILED — both providers exhausted, logging to memory`);
        await upsertPoint({
          timestamp: new Date().toISOString(),
          ecosystemVersion: ECOSYSTEM_VERSION,
          type: 'LLMFailure',
          message: 'Both LLM providers failed during fix_suggestion',
          details: { originalError: enriched.message, originalType: enriched.type },
        });
      } else {
        console.error(`[Decision] LLM call failed: ${e.message}`);
      }
      return;
    }

    console.log('[LLM RAW RESPONSE]');
    console.log(llmText);
    console.log('[END LLM RESPONSE]');

    let fixJson: FixSuggestion;
    try {
      fixJson = parseFixSuggestion(llmText);
      console.log(`[Decision] Fix parsed — file: ${fixJson.file} line: ${fixJson.line} action: ${fixJson.action}`);
    } catch (parseErr: unknown) {
      const e = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
      console.error('[PARSE ERROR] LLM did not return valid JSON:', e.message);
      console.error('[PARSE ERROR] Raw response was:', llmText);
      return;
    }

    // Phase 4: QA + Coder
    const tempPrUrl = `https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pull/pending`;
    console.log(`[Decision] Phase 4: sending to QA Bot`);
    const qaResult = await callQABot(fixJson, tempPrUrl);
    console.log(`[Decision] QA result: ${qaResult.status} — ${qaResult.reason}`);

    if (qaResult.status === 'FAIL') {
      console.warn(`[Decision] PR blocked by QA Bot — stopping`);
      return;
    }

    console.log(`[Decision] QA passed — sending to Coder Bot`);

    let branch: string;
    try {
      const coderResult = await callCoderBot(fixJson);
      branch = coderResult.branch;
      console.log(`[Decision] Coder Bot success — branch: ${branch}`);
    } catch (coderErr: unknown) {
      const e = coderErr instanceof Error ? coderErr : new Error(String(coderErr));
      console.error(`[Decision] Coder Bot failed: ${e.message}`);
      return;
    }

    const prBody = `## Auto-generated fix

**Error type:** ${enriched.type}

## Diagnosis
**Root cause:** ${diagnosis.rootCause}
**Confidence:** ${(diagnosis.confidence * 100).toFixed(0)}%
**Risk level:** ${diagnosis.riskLevel}

## Fix Applied
\`\`\`
File: ${fixJson.file}
Line: ${fixJson.line}
Action: ${fixJson.action}
New content: ${fixJson.newContent}
\`\`\`

**Description:** ${fixJson.description}

## Context Used
- Local recall: ${tier1Count} validated + ${tier2Count} unvalidated matches
- Ecosystem recall: ${ecosystemCount} cross-bot insights
- File content snapshot: ${enriched.fileContent ? 'yes' : 'no'}
- Recent commits fetched: ${enriched.recentCommits?.length ?? 0}
- Recurred after previous fix: ${enriched.recurredAfterFix ?? false}

---
_Generated by OpenClaw Coordinator v${BOT_VERSION}. Apply label before closing._`;

    const prUrl = await createFixPR(prBody, enriched.type, branch);
    console.log(`[Decision] PR opened: ${prUrl}`);

    // Write real PR URL back to Qdrant point now that we have it
    updatePrUrl(pointId, prUrl).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(`[Decision] Could not write prUrl back to point: ${err.message}`);
    });
    console.log(`[Decision] PR URL written back to point ${pointId}`);

    // Phase 5: Update state
    await setState('last_fix_completed', new Date().toISOString()).catch(() => {});
    await setState('last_fix_pr_url', prUrl).catch(() => {});
    console.log('[Decision] Phase 5: ecosystem state updated');

    console.log(`[Decision] ========== handleError complete ==========`);

  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error('[handleError] Failed:', e.message);
  } finally {
    await setState('coordinator_processing', 'false').catch(() => {});
    console.log('[Decision] Finally: coordinator_processing released');
  }
}

function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('hex')}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}

async function runCompactionCycle(): Promise<void> {
  try {
    await compactSmokeTests();
    console.log(`[Compact] Smoke done`);

    await compactCoordinatorLogs();
    console.log(`[Compact] Logs done`);

    await compactEcosystemMemory();
    console.log(`[Compact] Ecosystem done`);

    await collectMemoryMetrics();
    console.log(`[Compact] Metrics collected`);

  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error('[Compact] Cycle failed:', e.message);

    try {
      await createAlertIssue(
        '[OpenClaw Alert] Compaction cycle failed',
        `## Compaction Failure\n\n**Time:** ${new Date().toISOString()}\n\n**Error:** ${e.message}\n\n**Action required:** Check Fly logs for openclaw-coordinator and investigate.\n\n\`\`\`\nflyctl logs -a openclaw-coordinator\n\`\`\`\n\n_Generated automatically by OpenClaw Coordinator._`
      );
    } catch (issueErr: unknown) {
      const ie = issueErr instanceof Error ? issueErr : new Error(String(issueErr));
      console.error('[Compact] Failed to create alert issue:', ie.message);
    }
  }
}

async function main(): Promise<void> {
  console.log(`[Coordinator] Boot confirmed - v${BOT_VERSION} starting`);

  try {
    await ensureCollection('coordinator_logs');
    await ensureCollection('coordinator_smoke');
    await ensureCollection('coordinator_metrics');
    await ensureCollection('ecosystem_memory');
    await ensureCollection('researcher_logs');
    await ensureCollection('ecosystem_reputation');
    await ensureCollection('qa_logs');
    await ensureCollection('coder_logs');
    await ensureStateCollection();
    console.log('[Boot] All collections confirmed');
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error('[Boot] Collection setup failed:', err.message);
  }

  try {
    const recentExists = await recentSmokeExists();

    if (recentExists) {
      console.log('[Smoke] Recent smoke point found (< 1hr) — skipping write to avoid accumulation');
    } else {
      const smokeError: ErrorMemory = {
        timestamp: new Date().toISOString(),
        ecosystemVersion: ECOSYSTEM_VERSION,
        type: 'SmokeTest',
        message: 'boot smoke test — memory check only',
        details: { file: 'index.ts', line: 0 },
      };

      const id = await upsertPoint(smokeError, SMOKE_COLLECTION);
      console.log(`[Smoke] Upserted point ID: ${id} — written to coordinator_smoke`);
    }

    console.log('[Smoke] Memory layer confirmed OK — smoke isolated from recall');

  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error('[Smoke] Memory check failed:', err.message);
  }

  const server = http.createServer((req, res) => {

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', bot: 'openclaw-coordinator', version: BOT_VERSION }));
      return;
    }

    if (req.method === 'POST' && req.url === '/compact') {
      console.log('[Compact] /compact triggered — running full compaction cycle');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', message: 'Compaction running — watch logs' }));
      runCompactionCycle();
      return;
    }

    if (req.method === 'POST' && req.url === '/webhook') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const signature = req.headers['x-hub-signature-256'] as string | undefined;
        const secret = process.env.GITHUB_WEBHOOK_SECRET;

        if (!secret) {
          console.error('[Webhook] GITHUB_WEBHOOK_SECRET not set — rejecting');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Webhook secret not configured' }));
          return;
        }

        if (!signature) {
          console.warn('[Webhook] Missing X-Hub-Signature-256 header — rejecting');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing signature' }));
          return;
        }

        if (!verifyWebhookSignature(body, signature, secret)) {
          console.warn('[Webhook] Signature mismatch — rejecting');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(body) as Record<string, unknown>;
        } catch {
          console.warn('[Webhook] Invalid JSON body');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const action = payload.action as string | undefined;
        const pr = payload.pull_request as Record<string, unknown> | undefined;

        if (action !== 'closed' || !pr) {
          console.log(`[Webhook] Ignoring event — action=${action ?? 'unknown'}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ignored' }));
          return;
        }

        const merged = pr.merged as boolean | undefined;
        const prUrl = pr.html_url as string | undefined;

        if (!prUrl) {
          console.warn('[Webhook] No html_url in pull_request payload');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ignored', reason: 'no prUrl' }));
          return;
        }

        const labels = pr.labels as Array<{ name: string }> | undefined;
        const labelNames = (labels || []).map(l => l.name);

        let confidence: number;
        let outcomeLabel: ErrorMemory['outcomeLabel'] | undefined;

        if (!merged) {
          confidence = 0.0;
        } else if (labelNames.includes('suppressed-error')) {
          confidence = 0.0;
          outcomeLabel = 'suppressed-error';
        } else if (labelNames.includes('wrong-diagnosis')) {
          confidence = 0.4;
          outcomeLabel = 'wrong-diagnosis';
        } else if (labelNames.includes('correct-but-risky')) {
          confidence = 0.8;
          outcomeLabel = 'correct-but-risky';
        } else if (labelNames.includes('good-fix')) {
          confidence = 1.0;
          outcomeLabel = 'good-fix';
        } else {
          confidence = 0.7;
        }

        console.log(`[Webhook] PR closed — merged=${merged} labels=${labelNames.join(',')} confidence=${confidence} url=${prUrl}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted' }));

        updateConfidence(prUrl, confidence, outcomeLabel).catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          console.error('[Webhook] updateConfidence failed:', e.message);
        });
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/test-error') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        let testError: ErrorMemory;
        try {
          testError = JSON.parse(body) as ErrorMemory;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        console.log('[TEST] /test-error triggered');
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted', message: 'handleError() fired — watch logs' }));

        handleError(testError).catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          console.error('[TEST] handleError threw:', e.message);
        });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, '0.0.0.0', () => console.log(`[Health] Server on port ${PORT}`));
}

main().catch(console.error);
