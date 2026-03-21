import http from 'http';
import crypto from 'crypto';
import { upsertPoint, searchSimilarLogs, compactSmokeTests, updateConfidence, ErrorMemory } from './qdrant-logger.js';
import { writeToEcosystem, searchEcosystem } from './ecosystem-memory.js';
import Anthropic from '@anthropic-ai/sdk';
import { createFixPR } from './github-client.js';
import dotenv from 'dotenv';
dotenv.config();
console.log('[INFO] createFixPR loaded:', typeof createFixPR);

const PORT = 8080;
const SMOKE_COLLECTION = 'coordinator_smoke';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
    throw new Error('Missing or invalid fields in Claude JSON response');
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

export async function handleError(error: ErrorMemory): Promise<void> {
  console.log(`[handleError] Processing: ${error.type} — ${error.message}`);

  try {
    const id = await upsertPoint(error);
    console.log(`[handleError] Upserted point ID: ${id}`);

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

    const localContext = matches
      .filter(m => m.score > 0.65 && (m.payload.confidence ?? 0.5) > 0.3)
      .slice(0, 3)
      .map(m => {
        const payload = JSON.stringify(m.payload).slice(0, 200);
        return `Past fix (score ${m.score.toFixed(3)}, confidence ${(m.payload.confidence ?? 0.5).toFixed(2)}): ${payload}`;
      })
      .join('\n\n');

    const ecosystemContext = ecosystemMatches
      .slice(0, 2)
      .map(e => {
        const snippet = e.content.slice(0, 150);
        return `Cross-bot insight (${e.bot}): ${e.title} — ${snippet}`;
      })
      .join('\n\n');

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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );
    const claudeText = textBlock ? textBlock.text : '';

    console.log('[CLAUDE RAW RESPONSE]');
    console.log(claudeText);
    console.log('[END CLAUDE RESPONSE]');

    let fixJson: FixSuggestion;
    try {
      fixJson = parseFixSuggestion(claudeText);
      console.log('[INFO] Structured fix parsed:', JSON.stringify(fixJson));
    } catch (parseErr: unknown) {
      const e = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
      console.error('[PARSE ERROR] Claude did not return valid JSON:', e.message);
      console.error('[PARSE ERROR] Raw response was:', claudeText);
      return;
    }

    const tempPrUrl = `https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/pull/pending`;
    const qaResult = await callQABot(fixJson, tempPrUrl);

    if (qaResult.status === 'FAIL') {
      console.warn(`[WARN] PR blocked by QA Bot — ${qaResult.reason}`);
      return;
    }

    console.log('[INFO] QA passed — sending to Coder Bot');

    let branch: string;
    try {
      const coderResult = await callCoderBot(fixJson);
      branch = coderResult.branch;
    } catch (coderErr: unknown) {
      const e = coderErr instanceof Error ? coderErr : new Error(String(coderErr));
      console.error(`[CODER ERROR] ${e.message}`);
      return;
    }

    const prUrl = await createFixPR(
      `${fixJson.description}\n\n\`\`\`\nFile: ${fixJson.file}\nLine: ${fixJson.line}\nAction: ${fixJson.action}\nNew content: ${fixJson.newContent}\n\`\`\``,
      error.type,
      branch
    );
    console.log(`[SUCCESS] Fix PR ready for review: ${prUrl}`);

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

async function main(): Promise<void> {
  console.log('[Coordinator] Boot confirmed - memory-v2 starting');

  try {
    const smokeError: ErrorMemory = {
      timestamp: new Date().toISOString(),
      type: 'SmokeTest',
      message: 'boot smoke test — memory check only',
      details: { file: 'index.ts', line: 0 },
    };

    const id = await upsertPoint(smokeError, SMOKE_COLLECTION);
    console.log(`[Smoke] Upserted point ID: ${id} — written to coordinator_smoke`);
    console.log('[Smoke] Memory layer confirmed OK — smoke isolated from recall');

  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error('[Smoke] Memory check failed:', err.message);
  }

  const server = http.createServer((req, res) => {

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', bot: 'openclaw-coordinator', version: '1.4.0' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/compact') {
      console.log('[Compact] /compact triggered');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', message: 'Compaction running — watch logs' }));

      compactSmokeTests().then(result => {
        console.log(`[Compact] Complete — deleted: ${result.deleted}, kept: ${result.kept}`);
      }).catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        console.error('[Compact] Failed:', e.message);
      });
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
