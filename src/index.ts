import { createServer } from "http";
import { logger } from "./qdrant-logger.js";

async function run() {
  console.log(`[${new Date().toISOString()}] Coordinator started - Qdrant logging baseline active`);

  // Boot log to confirm
  await logger.info("Coordinator boot confirmed", {
    bootTime: new Date().toISOString(),
    version: "clean-slate-2026-03-17",
    region: process.env.FLY_REGION || "syd",
  });

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
