// src/index.ts
// Known-good memory test only + 0.0.0.0 binding fix for Fly health checks
// Pre-validation checkpoint passed: Fly docs + Node listen behaviour confirmed
import http from 'http';
import { upsertPoint, searchSimilarLogs, ErrorMemory } from './qdrant-logger.js';

const PORT = 8080;

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
  } catch (e) {
    console.error('[ERROR] Test failed:', e);
  }

  // FIXED: explicit 0.0.0.0 binding required for Fly proxy + health checks
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  }).listen(PORT, '0.0.0.0', () => console.log(`[Health] Server on port ${PORT}`));
}

main().catch(console.error);
