// src/index.ts
// Resolved merge: clean memory test + safe Claude proposal (PR creation still disabled)
import http from 'http';
import { upsertPoint, searchSimilarLogs, ErrorMemory } from './qdrant-logger.js';
import { Anthropic } from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 8080;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

async function main() {
  console.log('[Coordinator] Boot confirmed - memory-v1 starting');

  const testError: ErrorMemory = {
    timestamp: new Date().toISOString(),
    type: 'TypeScript',
    message: 'errors detected duplicate export',
    details: { file: 'qdrant-logger.ts', line: 42 },
    confidence: 0.9
  };

  try {
    // 1. Log the error to memory (always)
    const id = await upsertPoint(testError);
    console.log(`[Test] Error upserted - point ID: ${id}`);

    // 2. Search for similar past fixes
    const queryText = `${testError.type}: ${testError.message} ${JSON.stringify(testError.details || {})}`;
    const matches = await searchSimilarLogs(queryText);

    console.log('[Test] Recall results:', JSON.stringify(matches, null, 2));

    if (matches.length > 0 && matches[0].score > 0.65) {
      console.log(`[SUCCESS] Semantic recall working - best score: ${matches[0].score.toFixed(3)}`);

      // 3. Build context from good matches
      const context = matches
        .filter(m => m.score > 0.65)
        .map(m => `Past similar error/fix (score ${m.score.toFixed(3)}):\n${JSON.stringify(m.payload, null, 2)}`)
        .join('\n\n---\n\n');

      // 4. Claude prompt (tight, focused)
      const prompt = `
You are a senior TypeScript engineer fixing bugs in OpenClaw Coordinator.
Use previous similar errors and fixes only if relevant.

Previous fixes:
${context || '(none found)'}

Current new error to fix:
Type: ${testError.type}
Message: ${testError.message}
Details: ${JSON.stringify(testError.details || {})}

Task:
- Propose minimal code change (diff format)
- Include one-line commit message
- Suggest PR title and short body

Output ONLY in this exact format:

--- commit message ---
one line summary

--- PR title ---
short title

--- PR body ---
brief explanation

--- diff ---
\`\`\`diff
full patch here (against existing files)
\`\`\`

No extra text.
`;

      console.log('[DEBUG] Sending prompt to Claude...');

      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      });

      const claudeOutput = response.content[0].text;
      console.log('[CLAUDE FIX PROPOSAL]\n' + claudeOutput);

      // Rate-limiting note: future Octokit calls MUST use exponential backoff + retry
      // e.g. 3 attempts, delay = 1000 * (2 ** attempt)

    } else {
      console.warn('[WARN] No strong recall matches — no auto-fix attempted');
    }

  } catch (e) {
    console.error('[ERROR] Test / auto-fix failed:', e);
  }

  // Keep health server alive forever
  http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', memory: 'active' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  }).listen(PORT, () => console.log(`[Health] Server on port ${PORT}`));
}

main().catch(console.error);
