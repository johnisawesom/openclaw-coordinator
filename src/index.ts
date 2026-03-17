import http from 'http';
import { logErrorMemory, searchSimilarLogs, ErrorMemory } from './qdrant-logger.js';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 8080;

async function main() {
  console.log('[Coordinator] Boot confirmed - OpenClaw v1 starting');

  // Test error simulation - this should be upserted and searchable
  const testError: ErrorMemory = {
    timestamp: new Date().toISOString(),
    type: 'TypeScript',
    message: 'errors detected duplicate export',
    details: {
      file: 'example.ts',
      line: 42,
      previousFix: 'Added explicit export block and removed duplicate interface',
    },
  };

  try {
    const pointId = await logErrorMemory(testError);
    console.log(`[Test] Error logged to Qdrant - point ID: ${pointId}`);

    // Immediate recall test - should match the one we just logged
    const matches = await searchSimilarLogs(
      'TypeScript errors detected duplicate export',
      3,
      0.65
    );

    console.log('[Test] Recall results:');
    console.dir(matches, { depth: null, colors: true });

    if (matches.length === 0) {
      console.warn('[WARN] No matches found - check Qdrant collection config, HF token, or vector dimension');
    } else if (matches[0].score < 0.85) {
      console.warn(`[WARN] Best match score low (${matches[0].score}) - embeddings may be misconfigured`);
    } else {
      console.log('[SUCCESS] Semantic recall working - best match score:', matches[0].score);
    }
  } catch (err) {
    console.error('[ERROR] Memory test failed:', err);
    // Still keep alive
  }

  // Simple health server for Fly readiness probe
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(PORT, () => {
    console.log(`[Health] Server listening on port ${PORT}`);
  });
}

main().catch(err => {
  console.error('[FATAL] Coordinator crashed:', err);
  // Never process.exit() - keep alive for Fly
});
