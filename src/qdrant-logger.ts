import { createServer } from "http";
import { logger, logErrorMemory, searchSimilarLogs } from "./qdrant-logger.js";

const PROOF_MARKER = "PROOF_MARKER_QDRANT_TEST_20260314_V2";

async function simulateTscError() {
  // Simulate a real error path
  console.log("[coordinator] Simulating TSC failure...");
  
  const errorMessage = "TypeScript errors detected: src/index.ts(42,10): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
  
  // Push the error to Qdrant
  await logErrorMemory({
    bot_name: "coordinator",
    timestamp: new Date().toISOString(),
    message: errorMessage,
    context: { simulated: true, error_code: "TS2345" }
  });

  // Retrieve similar past errors
  console.log("[coordinator] Searching for similar past errors...");
  const similar = await searchSimilarLogs(errorMessage, 5, 0.6);

  if (similar.length > 0) {
    console.log("[coordinator] Found similar past issues:");
    similar.forEach((match, i) => {
      const payload = match.payload || {};
      console.log(`  #${i+1} score ${match.score.toFixed(4)} - "${payload.message || '(no message)'}..."`);
    });
  } else {
    console.log("[coordinator] No similar past errors found (score > 0.6)");
  }

  // TODO: later inject similar into Claude prompt
}

async function run() {
  console.log(`[${new Date().toISOString()}] ${PROOF_MARKER} — MINIMAL DEBUG VERSION IS NOW LIVE`);

  // Force test log
  console.log(`${PROOF_MARKER} — Forcing logErrorMemory test call...`);
  await logErrorMemory({
    bot_name: "coordinator",
    timestamp: new Date().toISOString(),
    message: "PROOF MARKER forced startup upsert test",
    context: { testId: "debug-v2" }
  });
  console.log(`${PROOF_MARKER} — logErrorMemory call completed (no throw)`);

  // Simulate error + retrieval
  await simulateTscError();

  // Minimal health server
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

run()
  .catch((err) => console.error(`${PROOF_MARKER} — Unhandled error:`, err))
  .finally(() => {
    console.log(`[${PROOF_MARKER}] [shutdown] Run finished — keeping server alive`);
  });
