// src/index.ts
import http from 'http';
import { upsertPoint, searchSimilarLogs, ErrorMemory } from './qdrant-logger.js';
import Anthropic from '@anthropic-ai/sdk';
import { createFixPR } from './github-client.js';
import dotenv from 'dotenv';
dotenv.config();
console.log('[INFO] createFixPR loaded:', typeof createFixPR);

const PORT = 8080;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function handleError(error: ErrorMemory): Promise<void> {
  console.log(`[handleError] Processing: ${error.type} — ${error.message}`);

  try {
    const id = await upsertPoint(error);
    console.log(`[handleError] Upserted point ID: ${id}`);

    const matches = await searchSimilarLogs(error.message);

    const context = matches
      .filter(m => m.score > 0.65)
      .map(m => `Past similar (score ${m.score.toFixed(3)}): ${JSON.stringify(m.payload)}`)
      .join('\n\n');

    const prompt = `You are a senior TypeScript engineer fixing OpenClaw Coordinator.

Current error:
${error.type}: ${error.message}
Details: ${JSON.stringify(error.details)}

Past similar fixes:
${context || '(none found)'}

Propose a minimal one-line fix or comment to add.
Output ONLY the suggestion (no extra text).`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );
    const claudeText = textBlock ? textBlock.text : 'No text response';

    console.log('[CLAUDE RAW RESPONSE]');
    console.log(claudeText);
    console.log('[END CLAUDE RESPONSE]');

    const prUrl = await createFixPR(claudeText, error.type);
    console.log(`[SUCCESS] Fix PR ready for review: ${prUrl}`);

  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error('[handleError] Failed:', e.message);
  }
}

async function main(): Promise<void> {
  console.log('[Coordinator] Boot confirmed - memory-v2 starting');

  // Boot-time smoke test — confirms memory + embedding only, no PR created
  try {
    const smokeError: ErrorMemory = {
      timestamp: new Date().toISOString(),
      type: 'SmokeTest',
      message: 'boot smoke test — memory check only',
      details: { file: 'index.ts', line: 0 },
    };

    const id = await upsertPoint(smokeError);
    console.log(`[Smoke] Upserted point ID: ${id}`);

    const matches = await searchSimilarLogs('boot smoke test memory check');
    console.log(`[Smoke] Recall found ${matches.length} matches`);

    if (matches.length > 0) {
      console.log(`[Smoke] Best score: ${matches[0].score}`);
    }

    console.log('[Smoke] Memory layer confirmed OK — no PR created on boot');

  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error('[Smoke] Memory check failed:', err.message);
  }

  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  }).listen(PORT, '0.0.0.0', () => console.log(`[Health] Server on port ${PORT}`));
}

main().catch(console.error);
