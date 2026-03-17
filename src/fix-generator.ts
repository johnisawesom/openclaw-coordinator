// src/fix-generator.ts
// Phase 2: use semantic recall → Claude → GitHub PR
import { Anthropic } from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
import { searchSimilarLogs, ErrorMemory } from './qdrant-logger';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN! });

const REPO_OWNER = 'johnisawesom';
const REPO_NAME = 'openclaw-coordinator';

export async function attemptAutoFix(error: ErrorMemory) {
  // 1. Search memory for similar past errors/fixes
  const similar = await searchSimilarLogs(
    `${error.type}: ${error.message} ${JSON.stringify(error.details || {})}`,
    3
  );

  const context = similar
    .map(r => `Past fix (score ${r.score.toFixed(3)}):\n${JSON.stringify(r.payload, null, 2)}`)
    .join('\n\n');

  const prompt = `
You are a senior TypeScript engineer fixing OpenClaw Coordinator bugs.
Previous similar errors and fixes:
${context || '(no previous fixes found)'}

Current error:
Type: ${error.type}
Message: ${error.message}
Details: ${JSON.stringify(error.details || {})}

Generate a minimal fix as a Git diff patch against src/ files.
Include commit message and PR title/description.
Only change necessary lines. Output format:

--- commit message ---
one-line summary

--- PR title ---
short title

--- PR body ---
explanation

--- diff ---
\`\`\`diff
... patch here ...
\`\`\`
`;

  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const fixText = response.content[0].text;

  // TODO: parse fixText to extract diff, title, body, commit msg
  // For now just log it – we can add parsing in next iteration
  console.log('[CLAUDE FIX PROPOSAL]\n', fixText);

  // 2. If confident, create PR (disabled for safety – enable after review)
  /*
  const pr = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: 'Auto-fix: ' + error.message.slice(0, 50),
    body: 'Auto-generated fix from coordinator memory recall',
    head: 'auto-fix-branch-' + Date.now(),
    base: 'main',
  });
  console.log('[PR CREATED]', pr.data.html_url);
  // Then update Qdrant point with fixPrUrl
  */
}
