// src/index.ts
import http from 'http';
import { upsertPoint, searchSimilarLogs, ErrorMemory } from './qdrant-logger.js';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config();

const PORT = 8080;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function main() {
  console.log('[Coordinator] Boot confirmed - memory-v1 starting');

  const testError: ErrorMemory = {
    timestamp: new Date().toISOString(),
    type: 'TypeScript',
    message: 'errors detected duplicate export',
    details: { file: 'qdrant-logger.ts', line: 42 },
  };

  try {
    const id = await upsertPoint(testError);
    console.log(`[Test] Error upserted - point ID: ${id}`);

    const matches = await searchSimilarLogs('TypeScript errors detected duplicate export');
    console.log('[Test] Recall results:', JSON.stringify(matches, null, 2));

    if (matches.length > 0 && matches[0].score > 0.8) {
      console.log(`[SUCCESS] Semantic recall working - best score: ${matches[0].score}`);
    } else {
      console.warn('[WARN] Recall weak or zero matches - check Qdrant config');
    }

    // Claude prompt test — safe text extraction
    try {
      const context = matches
        .filter(m => m.score > 0.65)
        .map(m => `Past similar (score ${m.score.toFixed(3)}): ${JSON.stringify(m.payload)}`)
        .join('\n\n');

      const prompt = `You are a senior TypeScript engineer fixing OpenClaw Coordinator.

Current error:
${testError.type}: ${testError.message}
Details: ${JSON.stringify(testError.details)}

Past similar fixes:
${context || '(none found)'}

Propose a minimal one-line fix or comment to add.
Output ONLY the suggestion (no extra text).`;

      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
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

    } catch (claudeErr: unknown) {
      const err = claudeErr instanceof Error ? claudeErr : new Error(String(claudeErr));
      console.error('[CLAUDE ERROR]:', err.message);
    }

  } catch (e) {
    console.error('[ERROR] Test failed:', e);
  }

  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  }).listen(PORT, '0.0.0.0', () => console.log(`[Health] Server on port ${PORT}`));
}

main().catch(console.error);
