// src/github-clients.ts
import { Octokit } from "@octokit/core";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { logger } from "./qdrant-logger.js";

// ── Singleton Octokit with throttling + retry ─────────────────────────────────

const ThrottledOctokit = Octokit.plugin(throttling, retry);

let _octokit: InstanceType<typeof ThrottledOctokit> | null = null;

export function getOctokit(): InstanceType<typeof ThrottledOctokit> {
  if (_octokit) return _octokit;

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN environment variable is not set");

  _octokit = new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit(retryAfter: number, options: any): boolean {
        logger
          .warn(`Rate limit hit for ${options.method} ${options.url} — retry in ${retryAfter}s`, {
            retryAfter,
            retryCount: options.request.retryCount,
          })
          .catch(console.error);
        return options.request.retryCount < 3;
      },
      onSecondaryRateLimit(retryAfter: number, options: any): boolean {
        logger
          .warn(`Secondary rate limit for ${options.method} ${options.url} — retry in ${retryAfter}s`, {
            retryAfter,
            retryCount: options.request.retryCount,
          })
          .catch(console.error);
        return options.request.retryCount < 2;
      },
    },
  });

  return _octokit;
}

// ── PR helpers ────────────────────────────────────────────────────────────────

export async function getPullRequest(owner: string, repo: string, pullNumber: number) {
  const octokit = getOctokit();
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
  });
  return data;
}

export async function createPullRequest(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body: string
) {
  const octokit = getOctokit();
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    title,
    head,
    base,
    body,
  });
  return data;
}

export async function mergePullRequest(
  owner: string,
  repo: string,
  pullNumber: number,
  commitTitle?: string
) {
  const octokit = getOctokit();
  const { data } = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    owner,
    repo,
    pull_number: pullNumber,
    commit_title: commitTitle,
    merge_method: "squash",
  });
  return data;
}

// ── Branch helpers ────────────────────────────────────────────────────────────

export async function createBranch(
  owner: string,
  repo: string,
  branchName: string,
  fromSha: string
) {
  const octokit = getOctokit();
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  });
  return data;
}

export async function deleteBranch(owner: string, repo: string, branchName: string) {
  const octokit = getOctokit();
  await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
    owner,
    repo,
    ref: `heads/${branchName}`,
  });
}

export async function getDefaultBranchSha(
  owner: string,
  repo: string,
  branch = "main"
): Promise<string> {
  const octokit = getOctokit();
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}", {
    owner,
    repo,
    branch,
  });
  return data.commit.sha;
}

// ── Commit helpers ────────────────────────────────────────────────────────────

export async function createCommit(
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentShas: string[]
) {
  const octokit = getOctokit();
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner,
    repo,
    message,
    tree: treeSha,
    parents: parentShas,
  });
  return data;
}

export async function updateBranchRef(
  owner: string,
  repo: string,
  branchName: string,
  commitSha: string,
  force = false
) {
  const octokit = getOctokit();
  const { data } = await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: commitSha,
    force,
  });
  return data;
}
