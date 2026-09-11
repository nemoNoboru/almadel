import { spawn } from "node:child_process";

export interface GitRunner {
  exec(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export const realGit: GitRunner = {
  exec(args, cwd) {
    return new Promise((resolve) => {
      const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("close", (exitCode) =>
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 }),
      );
    });
  },
};

export class GitError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Ensures the agent is on `branch`, creating it if needed. NEVER uses `-f`:
 * switching away from a dirty worktree is a hard error — we fail the ticket
 * rather than clobber user/agent work.
 *
 * A ticket may be claimed across multiple stages (planning -> implement ->
 * testing), all on the same branch. Re-claiming must be idempotent:
 *  - already on the branch -> no-op (continues work, dirty tree allowed),
 *  - branch exists on a clean tree -> `git checkout <branch>`,
 *  - branch is new on a clean tree -> `git checkout -b <branch>`.
 */
export async function checkoutBranch(
  git: GitRunner,
  branch: string,
  cwd: string,
): Promise<void> {
  // Git is an optional convenience, never a requirement. If the directory isn't
  // a git repository there is nothing to check out — the agent works in the
  // directory as-is and the prompt already names the branch.
  const inRepo = await git.exec(["rev-parse", "--git-dir"], cwd);
  if (inRepo.exitCode !== 0) return;

  const current = await git.exec(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (current.stdout.trim() === branch) return;

  const dirty = await git.exec(["status", "--porcelain"], cwd);
  if (dirty.stdout.trim() !== "") {
    throw new GitError(
      "worktree is dirty — refusing to switch branches (never force)",
    );
  }

  const exists = await git.exec(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd,
  );
  const args = exists.exitCode === 0 ? ["checkout", branch] : ["checkout", "-b", branch];

  const res = await git.exec(args, cwd);
  if (res.exitCode !== 0) {
    throw new GitError(
      `git checkout ${branch} failed: ${res.stderr.trim() || "unknown"}`,
    );
  }
}

/** Returns the slot to the default branch between tickets (no forced reset). */
export async function checkoutDefault(
  git: GitRunner,
  defaultBranch: string,
  cwd: string,
): Promise<void> {
  const inRepo = await git.exec(["rev-parse", "--git-dir"], cwd);
  if (inRepo.exitCode !== 0) return;

  const res = await git.exec(["checkout", defaultBranch], cwd);
  if (res.exitCode !== 0) {
    throw new GitError(
      `git checkout ${defaultBranch} failed: ${res.stderr.trim() || "unknown"}`,
    );
  }
}
