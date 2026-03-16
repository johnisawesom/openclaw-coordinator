import { logger } from './qdrant-logger';

async function logStartup() {
  await logger.info("Coordinator booted - clean-slate baseline active", {
    timestamp: new Date().toISOString(),
    version: "2026-03-17-green-deploy",
    region: "sydney",
    env: process.env.NODE_ENV || "production",
  });
}

logStartup().catch(err => {
  console.error("[startup-log] Failed to log boot:", err);
});
