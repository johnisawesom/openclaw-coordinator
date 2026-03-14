import { createServer } from "http";
import {
  logger,
  logErrorMemory,
  ErrorMemory,
} from "./qdrant-logger.js";

// ── Env validation ────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

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

// ── Main ──────────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
  await logger.info("OpenClaw Coordinator starting up");

  // FORCE Qdrant log every startup — this MUST appear in logs if code is live
  await logger.info("PROOF MARKER 2026-03-14: Qdrant logging FORCED every run");

  // Force simulated error memory EVERY run to trigger upsert
  const forcedMemory: ErrorMemory = {
    bot_name: "coordinator",
    timestamp: new Date().toISOString(),
    message: "Simulated error to force Qdrant upsert test",
    context: { test: "forced-every-run" },
  };
  await logErrorMemory(forcedMemory).catch((err) =>
    console.error("Forced logErrorMemory failed:", err.message)
  );

  await logger.info("Coordinator run complete");

  await new Promise((resolve) => setTimeout(resolve, 30000));
}

// ── Entry point ───────────────────────────────────────────────────────────────
run()
  .catch(async (err) => {
    await logger.error("Unhandled error in coordinator run", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }).catch(() => console.error("Logger failed during crash logging"));
    console.error("[CRASH] Coordinator threw error but server stays alive");
  })
  .finally(() => {
    console.log("[shutdown] Run finished — keeping server alive for Fly health check");
  });
