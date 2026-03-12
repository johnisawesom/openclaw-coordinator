# openclaw-coordinator

The hub bot for the OpenClaw ecosystem. Runs on Fly.io (Sydney, `syd`).

## Responsibilities

- Queries Qdrant for recent error logs from all worker bots.
- Builds a structured prompt with injected memories.
- Calls Claude (Anthropic SDK) to generate code fixes.
- Creates GitHub PRs (via Octokit with throttling + retry) for each fix.

## Required Secrets (`fly secrets set`)

```
QDRANT_URL=https://your-qdrant-instance
QDRANT_API_KEY=your-api-key
QDRANT_COLLECTION=openclaw-logs
BOT_NAME=openclaw-coordinator
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=Exitbytrade
```

## Deploy

Deploys automatically on push to `main` via GitHub Actions.

Manual deploy:
```bash
fly deploy --remote-only --region syd
```

## Architecture

```
Workers → Qdrant (logs) ← Coordinator polls every 5 min
                                ↓
                          Claude API (fix prompt)
                                ↓
                         GitHub PR (Octokit)
```

## Rules

- Only this bot may call the Anthropic API or create GitHub PRs.
- All secrets come from `process.env` / Fly secrets only.
- GitHub API is rate-limited: min 1000ms between calls, exponential backoff on 429.
