// src/index.ts
// Known-good memory test + minimal Anthropic auth check (v0.79.0)
// Verified tsc-clean: explicit catch type + narrowing, .js extension, no implicit any
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

    // Minimal Anthropic auth test — consumes 1 token max, only verifies key
    try {
      const testCall = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      });
      console.log('[TEST] Claude API connected successfully');
    } catch (claudeErr: unknown) {
      const err = claudeErr instanceof Error ? claudeErr : new Error(String(claudeErr));
      console.error('[TEST] Claude connection failed:', err.message);
    }

  } catch (e) {
    console.error('[ERROR] Test failed:', e);
  }

  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  }).listen(PORT, () => console.log(`[Health] Server on port ${PORT}`));
}

main().catch(console.error);
