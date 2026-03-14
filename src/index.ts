import { createServer } from "http";
import { logger, logErrorMemory } from "./qdrant-logger.js";

const PROOF_MARKER = "PROOF_MARKER_QDRANT_TEST_20260314_V2";

async function run() {
  console.log(`[${new Date().toISOString()}] ${PROOF_MARKER} — MINIMAL DEBUG VERSION IS NOW LIVE`);

  // Force Qdrant path immediately
  console.log(`${PROOF_MARKER} — Forcing logErrorMemory test call...`);
  try {
    await logErrorMemory({
      bot_name: "coordinator",
      timestamp: new Date().toISOString(),
      message: "PROOF MARKER forced startup upsert test",
      context: { testId: "debug-v2" }
    });
    console.log(`${PROOF_MARKER} — logErrorMemory call completed (no throw)`);
  } catch (err: any) {
    console.error(`${PROOF_MARKER} — logErrorMemory failed:`, err?.message || err);
  }

  // Minimal health server (keeps Fly happy)
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(8080, "0.0.0.0", () => {
    console.log("[health] Listening on 0.0.0.0:8080");
  });

  await logger.info("Coordinator run complete (proof version)");
}

// Keep alive exactly like before — no process.exit, no crash
run()
  .catch((err) => console.error(`${PROOF_MARKER} — Unhandled error:`, err))
  .finally(() => {
    console.log(`[${PROOF_MARKER}] [shutdown] Run finished — keeping server alive`);
    // Server stays running for Fly proxy
  });
