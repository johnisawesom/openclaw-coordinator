import { Octokit } from "@octokit/core";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { logger } from "./qdrant-logger";

// ── Augmented Octokit with throttling + retry ─────────────────────────────────
const ThrottledOctokit = Octokit.plugin(throttling, retry);

// ── Factory ───────────────────────────────────────────────────────────────────
function createGitHubClient(): InstanceType<typeof ThrottledOctokit> {
  const token = process.env["GITHUB_PAT"];
  if (!token) {
    throw new Error("GITHUB_PAT environment variable is required");
  }
  return new ThrottledOctokit({
    auth: token,
    throttle: {
      // Hard minimum: 1000ms between any two requests
      minimumDelay: 1000,
      onRateLimit: (retryAfter: number, options: any) => {
        void logger.warn("GitHub rate limit hit — retrying", {
          retryAfter,
          retryCount: options.request?.retryCount ?? 0,
          method: options.method,
          url: options.url,
        });
        // Retry up to 3 times on primary rate limit
        if ((options.request?.retryCount ?? 0) < 3) {
          return true;
        }
        void logger.error("GitHub rate limit exceeded — giving up after 3 retries", undefined, {
          method: options.method,
          url: options.url,
        });
        return false;
      },
      onSecondaryRateLimit: (retryAfter: number, options: any) => {
        void logger.warn("GitHub secondary/abuse rate limit hit — retrying", {
          retryAfter,
          retryCount: options.request?.retryCount ?? 0,
          method: options.method,
          url: options.url,
        });
        // On secondary/abuse limits: retry once with exponential backoff, then throw
        if ((options.request?.retryCount ?? 0) === 0) {
          return true;
        }
        // Do NOT silently swallow — throw so the coordinator knows this PR failed
        throw new Error(
          `GitHub secondary rate limit exceeded for ${options.method} ${options.url}`
        );
      },
    },
    request: {
      // Timeout individual requests after 30s
      timeout: 30_000,
      // Stop retrying when fewer than 50 remaining requests in current window
      throttle: {
        minimumRemaining: 50,
      },
    },
    // @octokit/plugin-retry: auto-retry on 5xx and network errors
    // Default: 3 retries with exponential backoff (handled by the plugin)
  });
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _octokit: InstanceType<typeof ThrottledOctokit> | null = null;
export function getGitHubClient(): InstanceType<typeof ThrottledOctokit> {
  if (!_octokit) {
    _octokit = createGitHubClient();
  }
  return _octokit;
}

// ── PR creation helper ────────────────────────────────────────────────────────
export interface CreatePROptions {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string; // branch name with the fix
  base: string; // usually "main"
}
export interface PullRequest {
  number: number;
  html_url: string;
  title: string;
}
export async function createPullRequest(opts: CreatePROptions): Promise<PullRequest> {
  const client = getGitHubClient();
  const response = await client.request("POST /repos/{owner}/{repo}/pulls", {
    owner: opts.owner,
    repo: opts.repo,
    title: opts.title,
    body: opts.body,
    head: opts.head,
    base: opts.base,
    draft: false,
  });
  return {
    number: response.data.number,
    html_url: response.data.html_url,
    title: response.data.title,
  };
}

// ── Branch creation helper ────────────────────────────────────────────────────
export interface CreateBranchOptions {
  owner: string;
  repo: string;
  branch: string;
  fromSha: string;
}
export async function createBranch(opts: CreateBranchOptions): Promise<void> {
  const client = getGitHubClient();
  await client.request("POST /repos/{owner}/{repo}/git/refs", {
    owner: opts.owner,
    repo: opts.repo,
    ref: `refs/heads/${opts.branch}`,
    sha: opts.fromSha,
  });
}

// ── File commit helper ────────────────────────────────────────────────────────
export interface CommitFileOptions {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  message: string;
  content: string; // base64-encoded file content
  sha?: string; // required when updating an existing file
}
export async function commitFile(opts: CommitFileOptions): Promise<void> {
  const client = getGitHubClient();
  await client.request("PUT /repos/{owner}/{repo}/contents/{path}", {
    owner: opts.owner,
    repo: opts.repo,
    path: opts.path,
    message: opts.message,
    content: opts.content,
    branch: opts.branch,
    ...(opts.sha ? { sha: opts.sha } : {}),
  });
}
