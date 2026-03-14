import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { createServer } from "http";
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
const REPO = requireEnv("GITHUB_REPO");
const GITHUB_PAT = requireEnv("GITHUB_PAT");

// Log secret presence (masked) for debug
console.log(`[startup] GITHUB_PAT present: ${!!GITHUB_PAT} (length: ${GITHUB_PAT?.length ?? 0})`);
console.log(`[startup] ANTHROPIC_API_KEY present: ${!!process.env.ANTHROPIC_API_KEY}`);
console.log(`[startup] QDRANT_URL present: ${!!process.env.QDRANT_URL}`);
console.log(`[startup] QDRANT_API_KEY present: ${!!process.env.QDRANT_API_KEY}`);

// ── Simple health server to keep machine alive & respond to Fly proxy ────────
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(8080, "0.0.0.0", () => {
  console.log("[health] Listening on 0.0.0.0:8080");
});

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

  // TEMP: uncomment ONLY to force error path test (after build succeeds)
  // throw new Error("Simulated coordinator crash to test logging + PR creation");

  // 1. Run tsc
  await logger.info("Running tsc --noEmit …");
  const { success, output: tscOutput } = runTsc(cwd);

  if (success) {
    await logger.info("TypeScript compilation succeeded — nothing to do.");
  } else {
    await logger.warn("TypeScript errors detected", { error_output: tscOutput });

    // 2. Persist error memories
    const errorMemories: ErrorMemory[] = parseErrorMemories(tscOutput);
    for (const mem of errorMemories) {
      await logErrorMemory(mem).catch((err) =>
        console.error("logErrorMemory failed (continuing):", err.message)
      );
    }

    // 3. Build fix prompt
    const { systemPrompt, userPrompt } = buildFixPrompt(tscOutput, errorMemories);
    await logger.info("Fix prompt constructed", {
      system_prompt_length: systemPrompt.length,
      user_prompt_length: userPrompt.length,
      error_count: errorMemories.length,
    });

    // 4. Write prompts to disk
    const promptDir = path.join(os.tmpdir(), "openclaw-prompts");
    fs.mkdirSync(promptDir, { recursive: true });
    const systemPath = path.join(promptDir, "system.txt");
    const userPath = path.join(promptDir, "user.txt");
    fs.writeFileSync(systemPath, systemPrompt, "utf-8");
    fs.writeFileSync(userPath, userPrompt, "utf-8");
    await logger.info("Prompts written to disk", { system_path: systemPath, user_path: userPath });

    // 5. Create fix branch
    let branchName: string | null = null;
    try {
      const baseSha = await getDefaultBranchSha(OWNER, REPO);
      branchName = `fix/tsc-errors-${Date.now()}`;
      if (!branchName) {
        throw new Error("branchName was falsy after generation");
      }
      // Explicit non-null assertion after guard — tsc should accept this
      await createBranch(OWNER, REPO, branchName!, baseSha);
      await logger.info("Fix branch created", { branch: branchName, base_sha: baseSha });
    } catch (err: any) {
      await logger.error("Failed to create fix branch", {
        error: err.message,
        stack: err.stack,
      });
    }

    // 6. Open draft PR
    if (branchName) {
      try {
        // branchName is string here
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
          pr_url: (pr as any).html_url,
        });
      } catch (err: any) {
        await logger.error("Failed to create draft PR", {
          error: err.message,
          stack: err.stack,
        });
      }
    } else {
      await logger.warn("Skipping PR — branchName was null or falsy");
    }
  }

  await logger.info("Coordinator run complete");

  // Keep alive temporarily
  await new Promise((resolve) => setTimeout(resolve, 30000));
}

// ── Entry point ───────────────────────────────────────────────────────────────
run()
  .catch(async (err) => {
    await logger.error("Unhandled error in coordinator run", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }).catch(() => {});
    process.exit(1);
  })
  .finally(() => {
    console.log("[shutdown] Run finished — keeping server alive for Fly health check");
  });
