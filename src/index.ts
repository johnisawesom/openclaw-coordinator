import { createServer } from "http";
import { logger, searchSimilarLogs } from "./qdrant-logger.js";

async function run() {
  console.log(`[${new Date().toISOString()}] Coordinator started - Phase 2 recall live`);

  // Boot log
  await logger.info("Coordinator boot confirmed - Phase 2 recall", {
    bootTime: new Date().toISOString(),
    version: "phase2-recall-2026-03-17",
    region: process.env.FLY_REGION || "syd",
  });

  // Simulate an error (for testing recall)
  console.log("Phase 2: Simulating TypeScript error to test recall");
  const simulatedError = {
    bot_name: "coordinator",
    timestamp: new Date().toISOString(),
    message: "TypeScript errors detected during build: duplicate export ErrorMemory",
    stack: new Error("Simulated TS2484").stack,
    context: {
      file: "qdrant-logger.ts",
      line: 226,
      fixAttempt: "removed export keyword from interface",
      outcome: "success"
    }
  };

  await logger.error("Simulated error for recall test", simulatedError);

  // Recall similar errors
  console.log("Phase 2: Searching for similar past errors...");
  try {
    const query = "TypeScript errors detected duplicate export";
    const matches = await searchSimilarLogs(query, 5, 0.6);

    console.log(`Phase 2: Recall found ${matches.length} similar errors`);

    if (matches.length > 0) {
      matches.forEach((match: any, i: number) => {
        const score = match.score?.toFixed(4) ?? "unknown";
        const payload = match.payload ?? {};
        console.log(`Recall ${i+1}: score=${score} | message="${payload.message || '(no message)'}..."`);
        console.log(`  Payload: ${JSON.stringify(payload, null, 2)}`);
      });

      // Meta-log the recall
      await logger.info("Recall results for simulated TS error", {
        query,
        matchCount: matches.length,
        matches: matches.map((m: any) => ({
          score: m.score,
          message: m.payload?.message,
          timestamp: m.payload?.timestamp
        }))
      });
    } else {
      console.log("Phase 2: No similar errors found yet");
    }
  } catch (err: any) {
    console.error("Phase 2: Recall search failed:", err?.message || String(err));
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

  console.log("run() finished - staying alive");
}

run().catch(err => console.error("Top-level error:", err));
