import { LLMRouter } from './llmRouter';
import crypto from 'crypto';
import {
  upsertPoint,
  searchSimilarLogs,
  compactSmokeTests,
  compactCoordinatorLogs,
  compactEcosystemMemory,
  collectMemoryMetrics,
  updateConfidence,
  recentSmokeExists,
  ErrorMemory,
  RecallMatch,
} from './qdrant-logger.js';
import { writeToEcosystem, searchEcosystem, EcosystemEntry } from './ecosystem-memory.js';
import { createFixPR, createAlertIssue } from './github-client.js';
import { callLLM } from './llm-router.js';
import dotenv from 'dotenv';
dotenv.config();
console.log('[INFO] createFixPR loaded:', typeof createFixPR);

const PORT = 8080;
const SMOKE_COLLECTION = 'coordinator_smoke';

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
  const tier1 = matches.filter(m => m.tier === 1);
  const tier2 = matches.filter(m => m.tier === 2 && (m.payload.confidence ?? 0.5) > 0.3);

  const selectedTier1 = tier1.slice(0, 3);
  const tier2Slots = Math.max(0, 2 - selectedTier1.length);
  const selectedTier2 = tier2Slots > 0 ? tier2.slice(0, tier2Slots) : [];
  const selected = [...selectedTier1, ...selectedTier2];

  const localContext = selected
    .map(m => {
      const payload = JSON.stringify(m.payload).slice(0, 200);
      const tierLabel = m.tier === 1 ? 'validated' : 'unvalidated';
      return `Past fix [${tierLabel}] (score ${m.score.toFixed(3)}, confidence ${(m.payload.confidence ?? 0.5).toFixed(2)}): ${payload}`;
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

export async function handleError(error: ErrorMemory): Promise<void> {
  console.log(`[Decision] ========== handleError start ==========`);
  console.log(`[Decision] Error type: ${error.type}`);
  console.log(`[Decision] Error message: ${error.message}`);

  try {
    const id = await upsertPoint(error);
    console.log(`[Decision] Upserted to coordinator_logs — point ID: ${id}`);

    writeToEcosystem({
      bot: 'coordinator',
      type: error.type,
      title: `${error.type}: ${error.message}`,
      content: JSON.stringify(error.details || {}),
      timestamp: error.timestamp || new Date().toISOString(),
      metadata: { pointId: id },
    }).catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Ecosystem] Write failed — not blocking handleError: ${e.message}`);
    });

    const [matches, ecosystemMatches] = await Promise.all([
      searchSimilarLogs(error.message),
      searchEcosystem(error.message),
    ]);

    const { localContext, ecosystemContext, tier1Count, tier2Count, ecosystemCount } =
      buildRecallContext(matches, ecosystemMatches);

    console.log(`[Decision] Recall tier1(validated): ${tier1Count} tier2(unvalidated): ${tier2Count} ecosystem: ${ecosystemCount}`);
    console.log(`[Decision] Proceeding to LLM with ${tier1Count + tier2Count} local + ${ecosystemCount} ecosystem context items`);
    console.log(`[Decision] Model: claude-haiku-4-5-20251001 (primary) gemini-1.5-flash (fallback)`);

    const prompt = `You are a senior TypeScript engineer fixing OpenClaw Coordinator.

Current error:
${error.type}: ${error.message}
Details: ${JSON.stringify(error.details)}

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
          type: 'LLMFailure',
          message: 'Both LLM providers failed during fix_suggestion',
          details: { originalError: error.message, originalType: error.type },
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

    const tempPrUrl = `https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pull/pending`;
    console.log(`[Decision] Sending to QA Bot for review`);
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

    const prUrl = await createFixPR(
      `${fixJson.description}\n\n\`\`\`\nFile: ${fixJson.file}\nLine: ${fixJson.line}\nAction: ${fixJson.action}\nNew content: ${fixJson.newContent}\n\`\`\``,
      error.type,
      branch
    );
    console.log(`[Decision] PR opened: ${prUrl}`);
    console.log(`[Decision] ========== handleError complete ==========`);

  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error('[handleError] Failed:', e.message);
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
    const smokeResult = await compactSmokeTests();
    console.log(`[Compact] Smoke done — deleted: ${smokeResult.deleted}, kept: ${smokeResult.kept}`);

    const logsResult = await compactCoordinatorLogs();
    console.log(`[Compact] Logs done — deleted: ${logsResult.deleted}, kept: ${logsResult.kept}`);

    const ecoResult = await compactEcosystemMemory();
    console.log(`[Compact] Ecosystem done — deleted: ${ecoResult.deleted}, kept: ${ecoResult.kept}`);

    await collectMemoryMetrics();

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
  console.log('[Coordinator] Boot confirmed - memory-v2 starting');

  try {
    const recentExists = await recentSmokeExists();

    if (recentExists) {
      console.log('[Smoke] Recent smoke point found (< 1hr) — skipping write to avoid accumulation');
    } else {
      const smokeError: ErrorMemory = {
        timestamp: new Date().toISOString(),
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
      res.end(JSON.stringify({ status: 'ok', bot: 'openclaw-coordinator', version: '1.8.0' }));
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

        const confidence = merged === true ? 1.0 : 0.0;
        console.log(`[Webhook] PR closed — merged=${merged} confidence=${confidence} url=${prUrl}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted' }));

        updateConfidence(prUrl, confidence).catch((err: unknown) => {
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
