// src/prompt-builder.ts
import { ErrorMemory } from "./qdrant-logger.js";

export type { ErrorMemory };

export interface FixPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function buildFixPrompt(
  tscErrors: string,
  recentMemories: ErrorMemory[] = []
): FixPrompt {
  const systemPrompt = `You are an expert TypeScript engineer specialising in strict ESM compilation \
(module: node16 / nodenext).
Your task is to produce minimal, correct code patches that resolve all TypeScript compiler errors \
without changing runtime behaviour.
Return ONLY the corrected file contents in fenced code blocks labelled with the filename. \
Do not add explanations outside the code blocks.`;

  const memorySummary =
    recentMemories.length > 0
      ? recentMemories
          .map(
            (m) =>
              `[${m.timestamp}] (${m.bot_name}) ${m.message}` +
              (m.stack ? `\n  Stack: ${m.stack}` : "")
          )
          .join("\n")
      : "No prior error memory.";

  const userPrompt = `## TypeScript Compiler Errors

\`\`\`
${tscErrors}
\`\`\`

## Prior Error Memory (most recent first)

${memorySummary}

## Instructions

1. Apply the minimal patch to each file to fix every error listed above.
2. Preserve all original logic — do not refactor beyond what is necessary.
3. Use explicit \`.js\` extensions on all relative imports.
4. Return each corrected file as a fenced TypeScript code block with the file path as the header comment.`;

  return { systemPrompt, userPrompt };
}
