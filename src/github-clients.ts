// src/github-clients.ts
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { logToQdrant } from "./qdrant-logger.js";

const ThrottledOctokit = Octokit.plugin(throttling);

let octokitSingleton: InstanceType<typeof ThrottledOctokit> | null = null;

export function getOctokit(): InstanceType<typeof ThrottledOctokit> {
  if (octokitSingleton) return octokitSingleton;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }

  octokitSingleton = new ThrottledOctokit({
    auth: token,
    throttle: {
      onRateLimit: (retryAfter: number, options: any) => {
        logToQdrant({
          level: "warn",
          message: `Rate limit hit for ${options.method} ${options.url}. Retrying after ${retryAfter}s.`,
          timestamp: new Date().toISOString(),
          context: { retryAfter, url: options.url, method: options.method },
        }).catch(console.error);
        return options.request.retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter: number, options: any) => {
        logToQdrant({
          level: "warn",
          message: `Secondary rate limit hit for ${options.method} ${options.url}. Retrying after ${retryAfter}s.`,
          timestamp: new Date().toISOString(),
          context: { retryAfter, url: options.url, method: options.method },
        }).catch(console.error);
        return options.request.retryCount < 2;
      },
    },
  });

  return octokitSingleton;
}

// ── PR helpers ────────────────────────────────────────────────────────────────

export async function getPullRequest(
  owner: string,
  repo: string,
  pullNumber: number
) {
  const octokit = getOctokit();
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
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
  const { data } = await octokit.pulls.create({ owner, repo, title, head, base, body });
  return data;
}

export async function mergePullRequest(
  owner: string,
  repo: string,
  pullNumber: number,
  commitTitle?: string
) {
  const octokit = getOctokit();
  const { data } = await octokit.pulls.merge({
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
  const { data } = await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  });
  return data;
}

export async function deleteBranch(
  owner: string,
  repo: string,
  branchName: string
) {
  const octokit = getOctokit();
  await octokit.git.deleteRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
  });
}

export async function getDefaultBranchSha(
  owner: string,
  repo: string,
  branch: string = "main"
): Promise<string> {
  const octokit = getOctokit();
  const { data } = await octokit.repos.getBranch({ owner, repo, branch });
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
  const { data } = await octokit.git.createCommit({
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
  force: boolean = false
) {
  const octokit = getOctokit();
  const { data } = await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: commitSha,
    force,
  });
  return data;
}
