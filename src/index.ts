import { createServer } from "http";
import { logger, searchSimilarLogs } from "./qdrant-logger.js";

async function run() {
  console.log(`[${new Date().toISOString()}] Coordinator started - Phase 2 active`);

  // Boot log
  await logger.info("Coordinator boot confirmed - Phase 2", {
    bootTime: new Date().toISOString(),
    version: "clean-slate-phase2-2026-03-17",
    region: process.env.FLY_REGION || "syd",
  });

  // Phase 2: Test semantic retrieval
  console.log("Phase 2: Testing semantic search for similar boot events...");
  try {
    const query = "Coordinator boot confirmed";  // Should match the log above
    const matches = await searchSimilarLogs(query, 3, 0.5);  // top 3, threshold 0.5

    console.log(`Phase 2: Found ${matches.length} similar logs`);

    if (matches.length > 0) {
      matches.forEach((match: any, i: number) => {
        const score = match.score?.toFixed(4) ?? "unknown";
        const payload = match.payload ?? {};
        console.log(`Match ${i+1}: score=${score} | message="${payload.message || '(no message)'}..."`);
        console.log(`  Payload: ${JSON.stringify(payload, null, 2)}`);
      });

      // Log the search results themselves as a new point (meta-log)
      await logger.info("Semantic search results for boot query", {
        query,
        matchCount: matches.length,
        matches: matches.map((m: any) => ({
          score: m.score,
          payload: m.payload,
        })),
      });
    } else {
      console.log("Phase 2: No similar logs found (expected on first runs)");
    }
  } catch (err: any) {
    console.error("Phase 2: searchSimilarLogs failed:", err?.message || String(err));
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
