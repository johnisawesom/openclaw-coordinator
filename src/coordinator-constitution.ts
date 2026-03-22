export const COORDINATOR_CONSTITUTION = `
ECOSYSTEM: OpenClaw — self-healing multi-bot system
RUNTIME: Node.js 20, TypeScript 5.4.5, ESM modules
PLATFORM: Fly.io Sydney region, Docker node:20-slim
OWNER: John (reviews all PRs, sole merge authority)

THIS BOT: openclaw-coordinator
PURPOSE: Detect errors, diagnose root causes, orchestrate fix pipeline
ENDPOINTS (must never be broken):
- GET /health returns {status:'ok', bot:'openclaw-coordinator', version:string}
- POST /webhook — GitHub PR events, signature verified always
- POST /test-error — triggers handleError() for testing
- POST /compact — runs memory compaction cycle

CRITICAL INVARIANTS:
- /health must always return HTTP 200
- Webhook signatures must always be verified before processing
- All errors must be written to coordinator_logs with confidence 0.5
- Rate limit events (429) must NEVER be written to Qdrant
- LLM calls must go through llm-router.ts only
- Exactly one PR per error event
- auto_stop_machines must never be set to true

DEPENDENCIES:
- openclaw-embedder at EMBEDDER_URL — returns 503 during warmup, retry
- openclaw-qa at QA_BOT_URL — must pass before any PR opened
- openclaw-coder-bot at CODER_BOT_URL — applies fix to branch
- Qdrant at QDRANT_URL — collections: coordinator_logs, coordinator_smoke, ecosystem_memory

CODEBASE RULES:
- All local imports end in .js (ESM requirement)
- TypeScript strict mode — no implicit any
- All catch blocks must log the error — never swallow silently
- No package-lock.json — use npm install not npm ci
- Raw http module only — express is NOT used in this bot

WHAT GOOD FIXES LOOK LIKE:
- Change minimum lines necessary (prefer 1-5 lines)
- Touch only the file specified
- Preserve all existing error handling
- Add null checks rather than removing code
- Fix root cause — do not suppress symptoms

WHAT BAD FIXES LOOK LIKE:
- Wrapping errors in empty catch blocks
- Returning early to avoid the error path
- Commenting out the failing code
- Changing model strings or collection names
- Removing .js extensions from imports
`;
