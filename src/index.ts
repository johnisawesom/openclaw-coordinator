import "dotenv/config";
import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { QdrantClient } from "@qdrant/js-client-rest";
import { logger } from "./qdrant-logger.js";
import { buildFixPrompt, type ErrorMemory } from "./prompt-builder.js";
import { createBranch, createPullRequest, commitFile } from "./github-client.js";

// ── Env validation ────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

const BOT_NAME = process.env["BOT_NAME"] ?? "openclaw-coordinator";
const PORT = parseInt(process.env["PORT"] ?? "8080", 10);
const POLL_INTERVAL_MS = parseInt(process.env["POLL_INTERVAL_MS"] ?? "300000", 10);
const GITHUB_OWNER = process.env["GITHUB_OWNER"] ?? "Exitbytrade";
// How many recent error memories to pull per poll cycle
const MEMORY_LIMIT = parseInt(process.env["MEMORY_LIMIT"] ?? "20", 10);

// ── Anthropic client ──────────────────────────────────────────────────────────

function createAnthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
  });
}

// ── Qdrant helpers ────────────────────────────────────────────────────────────

function createQdrantClient(): QdrantClient {
  return new QdrantClient({
    url: requireEnv("QDRANT_URL"),
    apiKey: process.env["QDRANT_API_KEY"],
  });
}

/**
 * Fetch recent error-level log entries from Qdrant across all worker bots.
 * Returns up to `limit` records ordered by timestamp descending.
 */
async function fetchRecentErrors(
  qdrant: QdrantClient,
  collection: string,
  limit: number
): Promise<ErrorMemory[]> {
  const result = await qdrant.scroll(collection, {
    filter: {
      must: [
        {
          key: "level",
          match: { value: "error" },
        },
      ],
    },
    limit,
    with_payload: true,
    with_vector: false,
  });

  const points = result.points ?? [];

  // Sort client-side by timestamp desc (Qdrant scroll doesn't guarantee order)
  const sorted = points
    .map((p) => p.payload as unknown as ErrorMemory)
    .filter((p) => p?.timestamp && p?.bot_name)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return sorted;
}

// ── Claude fix generation ─────────────────────────────────────────────────────

interface ClaudeFix {
  file_path: string;
  fixed_content: string | null;
  pr_title: string;
  pr_body: string;
  confidence: number;
  target_repo: string;
}

async function generateFix(
  anthropic: Anthropic,
  memories: ErrorMemory[]
): Promise<ClaudeFix | null> {
  if (memories.length === 0) {
    await logger.info("No error memories to process — skipping Claude call");
    return null;
  }

  const { systemPrompt, userPrompt } = buildFixPrompt(memories);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    await logger.warn("Claude returned no text block", { stop_reason: response.stop_reason });
    return null;
  }

  let parsed: ClaudeFix;
  try {
    // Strip potential markdown fences before parsing
    const raw = textBlock.text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(raw) as ClaudeFix;
  } catch (err) {
    await logger.error("Failed to parse Claude response as JSON", err, {
      raw_response: textBlock.text.slice(0, 500),
    });
    return null;
  }

  return parsed;
}

// ── PR creation ───────────────────────────────────────────────────────────────

async function createFixPR(fix: ClaudeFix): Promise<void> {
  if (!fix.fixed_content) {
    await logger.warn("Claude confidence too low — skipping PR creation", {
      pr_title: fix.pr_title,
      confidence: fix.confidence,
    });
    return;
  }

  const repo = fix.target_repo ?? "worker-base-template"; // fallback
  const branchName = `fix/coordinator-${Date.now()}`;

  // 1. Get current default branch SHA
  // (In a full implementation, fetch via getGitHubClient().request("GET /repos/{owner}/{repo}"))
  // TODO: resolve actual SHA dynamically
  const baseSha = process.env["GITHUB_BASE_SHA"] ?? "";

  if (!baseSha) {
    await logger.warn("GITHUB_BASE_SHA not set — skipping branch creation", { repo });
    return;
  }

  // 2. Create fix branch
  await createBranch({ owner: GITHUB_OWNER, repo, branch: branchName, fromSha: baseSha });

  // 3. Commit the fixed file
  const encodedContent = Buffer.from(fix.fixed_content, "utf-8").toString("base64");
  await commitFile({
    owner: GITHUB_OWNER,
    repo,
    branch: branchName,
    path: fix.file_path,
    message: `fix: ${fix.pr_title}`,
    content: encodedContent,
  });

  // 4. Open PR
  const pr = await createPullRequest({
    owner: GITHUB_OWNER,
    repo,
    title: fix.pr_title,
    body: [
      fix.pr_body,
      "",
      `---`,
      `*Generated by openclaw-coordinator — confidence: ${(fix.confidence * 100).toFixed(1)}%*`,
    ].join("\n"),
    head: branchName,
    base: "main",
  });

  await logger.info("PR created successfully", {
    pr_number: pr.number,
    pr_url: pr.html_url,
    confidence: fix.confidence,
    file_path: fix.file_path,
  });
}

// ── Main coordinator loop ─────────────────────────────────────────────────────

async function runCoordinatorCycle(
  anthropic: Anthropic,
  qdrant: QdrantClient,
  collection: string
): Promise<void> {
  await logger.info("Coordinator cycle starting", { memory_limit: MEMORY_LIMIT });

  // Step 1: Query Qdrant for recent errors across all worker bots
  let memories: ErrorMemory[];
  try {
    memories = await fetchRecentErrors(qdrant, collection, MEMORY_LIMIT);
  } catch (err) {
    await logger.error("Failed to fetch error memories from Qdrant", err);
    return;
  }

  await logger.info("Fetched error memories", { count: memories.length });

  if (memories.length === 0) {
    await logger.info("All quiet — no errors in recent window");
    return;
  }

  // Step 2: Build prompt with injected memories → call Claude
  let fix: ClaudeFix | null;
  try {
    fix = await generateFix(anthropic, memories);
  } catch (err) {
    await logger.error("Claude API call failed", err, { memory_count: memories.length });
    return;
  }

  if (!fix) return;

  await logger.info("Claude fix generated", {
    confidence: fix.confidence,
    file_path: fix.file_path,
    pr_title: fix.pr_title,
  });

  // Step 3: Create GitHub PR with the fix
  try {
    await createFixPR(fix);
  } catch (err) {
    await logger.error("Failed to create fix PR", err, {
      pr_title: fix.pr_title,
      file_path: fix.file_path,
    });
  }
}

// ── Health server ─────────────────────────────────────────────────────────────

function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", bot: BOT_NAME, ts: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), bot: BOT_NAME, msg: `Health server on :${PORT}` })
    );
  });

  return server;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function setupGracefulShutdown(server: http.Server, interval: NodeJS.Timeout): void {
  async function shutdown(signal: string): Promise<void> {
    await logger.info("Shutting down", { signal });
    clearInterval(interval);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// ── Unhandled errors ──────────────────────────────────────────────────────────

process.on("uncaughtException", (error: Error) => {
  void logger.error("Uncaught exception", error, { fatal: true });
  setTimeout(() => process.exit(1), 2_000).unref();
});

process.on("unhandledRejection", (reason: unknown) => {
  void logger.error("Unhandled promise rejection", reason, { fatal: true });
  setTimeout(() => process.exit(1), 2_000).unref();
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate all required secrets upfront
  try {
    requireEnv("QDRANT_URL");
    requireEnv("QDRANT_COLLECTION");
    requireEnv("ANTHROPIC_API_KEY");
    requireEnv("GITHUB_TOKEN");
  } catch (err) {
    console.error("Startup failed:", (err as Error).message);
    process.exit(1);
  }

  const collection = process.env["QDRANT_COLLECTION"] ?? "openclaw-logs";
  const anthropic = createAnthropicClient();
  const qdrant = createQdrantClient();

  await logger.info("Coordinator starting up", {
    bot_name: BOT_NAME,
    node_version: process.version,
    poll_interval_ms: POLL_INTERVAL_MS,
    env: process.env["NODE_ENV"] ?? "development",
  });

  const server = startHealthServer();

  // Run first cycle immediately on startup
  try {
    await runCoordinatorCycle(anthropic, qdrant, collection);
  } catch (err) {
    await logger.error("Coordinator cycle failed on startup", err);
  }

  // Then poll every POLL_INTERVAL_MS (default: 5 minutes)
  const interval = setInterval(async () => {
    try {
      await runCoordinatorCycle(anthropic, qdrant, collection);
    } catch (err) {
      await logger.error("Coordinator cycle failed", err);
    }
  }, POLL_INTERVAL_MS);

  setupGracefulShutdown(server, interval);
}

main().catch((err) => {
  console.error("Fatal error in main():", err);
  process.exit(1);
});
