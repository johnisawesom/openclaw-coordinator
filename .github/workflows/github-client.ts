import { Octokit } from "@octokit/rest";

const OWNER = process.env.GITHUB_OWNER ?? "";
const REPO = process.env.GITHUB_REPO ?? "";

if (!OWNER || !REPO) {
  console.error("[ERROR] GITHUB_OWNER or GITHUB_REPO env var is missing");
}

console.log(`[INFO] github-client loaded for ${OWNER}/${REPO}`);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      const isRateLimit =
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        (err as { status: number }).status === 403;

      if (isRateLimit) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(
          `[WARN] GitHub rate limit hit (attempt ${attempt + 1}/${maxRetries}). Waiting ${backoffMs}ms...`
        );
        await sleep(backoffMs);
      } else {
        throw err;
      }
    }
  }

  throw lastError;
}

export async function createFixPR(
  branchName: string,
  prTitle: string,
  prBody: string
): Promise<string> {
  const token = process.env.GITHUB_PAT ?? "";

  if (!token) {
    throw new Error("[ERROR] GITHUB_PAT secret is missing — cannot create PR");
  }

  const octokit = new Octokit({ auth: token });

  const pr = await withRateLimitRetry(() =>
    octokit.rest.pulls.create({
      owner: OWNER,
      repo: REPO,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: "main",
    })
  );

  console.log(`[SUCCESS] PR created: ${pr.data.html_url}`);
  return pr.data.html_url;
}
