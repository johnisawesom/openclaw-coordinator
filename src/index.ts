import { createServer } from "http";
import { logger, logErrorMemory } from "./qdrant-logger.js";

const PROOF_MARKER = "PROOF_MARKER_QDRANT_TEST_20260317_V3";

async function run() {
  console.log(`[${new Date().toISOString()}] ${PROOF_MARKER} — Coordinator starting`);

  // Step 1: Check env vars early
  console.log(`${PROOF_MARKER} — Env check: QDRANT_URL present = ${!!process.env.QDRANT_URL}`);
  console.log(`${PROOF_MARKER} — Env check: QDRANT_API_KEY present = ${!!process.env.QDRANT_API_KEY}`);

  // Step 2: Force logger.info (normal path)
  console.log(`${PROOF_MARKER} — Step 1: Calling logger.info`);
  try {
    await logger.info("Coordinator boot - V3 visibility test", {
      proofMarker: PROOF_MARKER,
      bootTime: new Date().toISOString(),
      flyRegion: process.env.FLY_REGION || "unknown",
      qdrantUrlPresent: !!process.env.QDRANT_URL,
      qdrantKeyPresent: !!process.env.QDRANT_API_KEY,
    });
    console.log(`${PROOF_MARKER} — logger.info completed OK`);
  } catch (err: any) {
    console.error(`${PROOF_MARKER} — logger.info CRASHED:`, err?.message || String(err), err?.stack || "");
  }

  // Step 3: Force logErrorMemory (error path)
  console.log(`${PROOF_MARKER} — Step 2: Calling logErrorMemory`);
  try {
    await logErrorMemory({
      bot_name: "coordinator",
      timestamp: new Date().toISOString(),
      message: "V3 forced error memory test - please upsert",
      stack: new Error("test stack trace").stack,
      context: { testId: "v3-visibility", envCheck: !!process.env.QDRANT_URL }
    });
    console.log(`${PROOF_MARKER} — logErrorMemory completed OK`);
  } catch (err: any) {
    console.error(`${PROOF_MARKER} — logErrorMemory CRASHED:`, err?.message || String(err), err?.stack || "");
  }

  // Health server
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

  console.log(`${PROOF_MARKER} — run() finished - staying alive`);
}

run()
  .catch((err) => {
    console.error(`${PROOF_MARKER} — Top-level crash:`, err);
  })
  .finally(() => {
    console.log(`[${PROOF_MARKER}] Keeping process alive`);
  });
