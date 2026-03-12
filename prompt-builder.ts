// ── Types ─────────────────────────────────────────────────────────────────────

export interface ErrorMemory {
  timestamp: string;
  bot_name: string;
  level: string;
  message: string;
  error_stack: string | null;
  context: Record<string, unknown>;
  vectorizable_text: string;
}

export interface FixPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ── Stub ──────────────────────────────────────────────────────────────────────

/**
 * buildFixPrompt — constructs a structured prompt for Claude to generate a code fix.
 *
 * TODO: Flesh this out once the vector search + memory retrieval pipeline is wired up.
 * The coordinator will call this with the N most-recent/relevant error memories
 * retrieved from Qdrant, then pass the result to the Anthropic SDK.
 *
 * @param memories  Array of recent error log entries from Qdrant
 * @returns         System + user prompt strings ready for claude-3-5-sonnet-latest
 */
export function buildFixPrompt(_memories: ErrorMemory[]): FixPromptResult {
  // TODO: implement full prompt construction
  // Suggested structure:
  //   1. Group memories by bot_name
  //   2. Summarise recurring errors vs one-off spikes
  //   3. Include error_stack and context verbatim for the top 3 errors
  //   4. Ask Claude for: (a) root-cause analysis, (b) a minimal TypeScript patch,
  //      (c) the target file path relative to repo root, (d) confidence score

  const systemPrompt = `You are an expert TypeScript/Node.js engineer embedded in the OpenClaw self-healing bot ecosystem.
Your job is to analyse structured error logs from autonomous worker bots running on Fly.io and produce minimal, targeted code fixes.

Rules:
- Output ONLY valid TypeScript. No explanation prose outside of code comments.
- The fix must be a complete file replacement (not a diff).
- Respond with a single JSON object: { "file_path": string, "fixed_content": string, "pr_title": string, "pr_body": string, "confidence": number }
- confidence is a float 0–1 indicating how certain you are this fix is correct.
- If confidence < 0.6, set fixed_content to null and explain in pr_body why.`;

  const userPrompt = `[STUB — memories not yet injected. Implement buildFixPrompt() in src/prompt-builder.ts]`;

  return { systemPrompt, userPrompt };
}
