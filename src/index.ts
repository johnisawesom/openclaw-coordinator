// src/index.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
  logger,
  logErrorMemory,
  ErrorMemory,
} from "./qdrant-logger.js";
import {
  createBranch,
  createPullRequest,
  getDefaultBranchSha,
} from "./github-clients.js";
import { buildFixPrompt } from "./prompt-builder.js";

// ── Env validation ────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const OWNER = requireEnv("GITHUB_OWNER");
const REPO  = requireEnv("GITHUB_REPO");

// ── TSC runner ────────────────────────────────────────────────────────────────

function runTsc(cwd: string): { success: boolean; output: string } {
  try {
    execSync("npx tsc --noEmit", { cwd, stdio: "pipe" });
    return { success: true, output: "" };
  } catch (err: any) {
    const output: string =
      (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
    return { success: false, output };
  }
}

// ── Error memory helpers ──────────────────────────────────────────────────────

function parseErrorMemories(tscOutput: string): ErrorMemory[] {
  const botName = process.env.BOT_NAME ?? "coordinator";
  const now = new Date().toISOString();
  return tscOutput
    .split("\n")
    .filter((l) => l.includes("error TS"))
    .map((line, idx) => ({
      bot_name: botName,
      timestamp: now,
      message: line.trim(),
      context: { line_index: idx },
    }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  await logger.info("OpenClaw Coordinator starting up", { owner: OWNER, repo: REPO });

  const cwd = process.cwd();

  // 1. Run tsc
  await logger.info("Running tsc --noEmit …");
  const { success, output: tscOutput } = runTsc(cwd);

  if (success) {
    await logger.info("TypeScript compilation succeeded — nothing to do.");
    return;
  }

  await logger.warn("TypeScript errors detected", { error_output: tscOutput });

  // 2. Persist error memories
  const errorMemories: ErrorMemory[] = parseErrorMemories(tscOutput);
  for (const mem of errorMemories) {
    await logErrorMemory(mem);
  }

  // 3. Build fix prompt — pass tscOutput as currentError + memories as context
  const { systemPrompt, userPrompt } = buildFixPrompt(tscOutput, errorMemories);

  await logger.info("Fix prompt constructed", {
    system_prompt_length: systemPrompt.length,
    user_prompt_length:   userPrompt.length,
    error_count:          errorMemories.length,
  });

  // 4. Write prompts to disk for downstream agents
  const promptDir = path.join(os.tmpdir(), "openclaw-prompts");
  fs.mkdirSync(promptDir, { recursive: true });

  const systemPath = path.join(promptDir, "system.txt");
  const userPath   = path.join(promptDir, "user.txt");

  fs.writeFileSync(systemPath, systemPrompt, "utf-8");
  fs.writeFileSync(userPath,   userPrompt,   "utf-8");

  await logger.info("Prompts written to disk", { system_path: systemPath, user_path: userPath });

  // 5. Create fix branch
  let branchName: string | null = null;
  try {
    const baseSha = await getDefaultBranchSha(OWNER, REPO);
    branchName = `fix/tsc-errors-${Date.now()}`;
    await createBranch(OWNER, REPO, branchName, baseSha);
    await logger.info("Fix branch created", { branch: branchName, base_sha: baseSha });
  } catch (err) {
    await logger.error("Failed to create fix branch", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. Open draft PR
  if (branchName) {
    try {
      const pr = await createPullRequest(
        OWNER,
        REPO,
        `[OpenClaw] Fix TypeScript compilation errors (${errorMemories.length} errors)`,
        branchName,
        "main",
        `## Automated Fix\n\nThis PR was opened by the OpenClaw Coordinator to address ` +
          `${errorMemories.length} TypeScript compiler error(s).\n\n### Errors\n\n\`\`\`\n` +
          `${tscOutput.slice(0, 3000)}\n\`\`\``
      );
      await logger.info("Draft PR created", {
        pr_number: (pr as any).number,
        pr_url:    (pr as any).html_url,
      });
    } catch (err) {
      await logger.error("Failed to create draft PR", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await logger.info("Coordinator run complete");
}

// ── Entry point ───────────────────────────────────────────────────────────────

run().catch(async (err) => {
  await logger.error("Unhandled error in coordinator run", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }).catch(() => {});
  process.exit(1);
});
