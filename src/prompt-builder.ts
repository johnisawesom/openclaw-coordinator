// src/prompt-builder.ts
// Minimal prompt builder for Phase 1 Coordinator
// Takes recent error memories from Qdrant + current failure → builds Claude prompt

export interface ErrorMemory {
  timestamp: string;          // ISO string
  errorMessage: string;
  stackTrace?: string;
  context?: Record<string, any>; // e.g. { url: "...", status: 403 }
  attemptedFix?: string;      // previous Claude suggestion if any
  outcome?: "success" | "failed" | "unknown";
}

/**
 * Builds the system + user prompt for Claude to generate a code fix.
 * In Phase 1 this is basic string interpolation.
 * Later versions will use Qdrant vector similarity + filtering.
 */
export function buildFixPrompt(
  currentError: {
    message: string;
    stack?: string;
    context?: Record<string, any>;
  },
  recentMemories: ErrorMemory[] = []  // from Qdrant scroll/query
): string {
  const memorySummary = recentMemories
    .map((mem, i) => `
[${i + 1}] ${mem.timestamp} | ${mem.errorMessage}
   Context: ${JSON.stringify(mem.context ?? {}, null, 2)}
   Previous attempted fix: ${mem.attemptedFix ?? "none"}
   Outcome: ${mem.outcome ?? "unknown"}
`)
    .join("\n\n");

  const systemPrompt = `
You are the autonomous coding engine for OpenClaw - a self-evolving bot ecosystem on Fly.io.
Rules you MUST follow (never break these):
- All bots are Node.js + TypeScript
- Playwright MUST be pinned to EXACTLY version 1.40.1 in package.json AND Dockerfile (apt + npm)
- NO SSH access ever
- NO manual CLI commands after initial bootstrap
- Use GitOps only: create branch → commit fix → PR → merge triggers fly deploy
- Push structured JSON logs/errors to Qdrant on every failure/success
- Keep bots immutable, versioned, template-driven
- Prefer simplicity over cleverness
- If Playwright involved: always use headless: true, slowMo: 0, args: ['--no-sandbox', '--disable-setuid-sandbox']
Past ecosystem failures (do NOT repeat):
- Railway shared IPs → GitHub rate limits
- FalkorDB/AutoMem hallucinations
- Broken OAuth / identity.md loops
`;

  const userPrompt = `
Recent similar failures from Qdrant (learn from them):
${memorySummary || "(No recent memories yet - first failure)"}

Current failure to fix:
Error: ${currentError.message}
${currentError.stack ? `Stack:\n${currentError.stack}` : ""}
Context: ${JSON.stringify(currentError.context ?? {}, null, 2)}

Generate ONLY the code diff/fix in GitHub-friendly format:
1. Full new file content if creating
2. Or unified diff if editing existing file
3. Commit message
4. PR title & body

Do NOT explain, do NOT add commentary outside the fix. Output pure code + metadata.
`;

  return `${systemPrompt}\n\n${userPrompt}`;
}
