import { spawn } from "node:child_process";
import { join } from "node:path";

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

/** Absolute path for a ticket's isolated worktree under `<repoRoot>/.almadel/wt/`. */
export function worktreePathFor(repoRoot: string, ticket: string): string {
  return join(repoRoot, ".almadel", "wt", ticket);
}

interface PrepareOpts {
  repoRoot: string;
  branch: string;
  defaultBranch: string;
  ticket: string;
}

function listHasPath(stdout: string, targetPath: string): boolean {
  return stdout.split("\n").some((line) => line === `worktree ${targetPath}`);
}

/**
 * Prepares (or reclaims) an isolated git worktree for a ticket on `branch`, and
 * returns the path the agent should work in.
 *
 * - Not a git repo -> returns `repoRoot` (work in place; isolation unavailable).
 * - Worktree already registered -> reuse it (idempotent re-claim after a crash
 *   or requeue; the change is preserved, never clobbered).
 * - Branch already exists -> `git worktree add <path> <branch>`.
 * - Branch is new -> `git worktree add <path> -b <branch> <defaultBranch>` (branches
 *   from the default, never from the primary checkout's possibly-dirty HEAD).
 *
 * NEVER uses `-f`: a dirty worktree is EXPECTED uncommitted agent work, kept for
 * review. Each ticket gets its own worktree so tickets can never dirty-block one
 * another.
 */
export async function prepareTicketWorktree(
  git: GitRunner,
  opts: PrepareOpts,
): Promise<string> {
  const { repoRoot, branch, defaultBranch, ticket } = opts;

  const inRepo = await git.exec(["rev-parse", "--git-dir"], repoRoot);
  if (inRepo.exitCode !== 0) return repoRoot;

  const targetPath = worktreePathFor(repoRoot, ticket);

  const list = await git.exec(["worktree", "list", "--porcelain"], repoRoot);
  if (list.exitCode === 0 && listHasPath(list.stdout, targetPath)) {
    return targetPath;
  }

  const exists = await git.exec(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    repoRoot,
  );
  const args =
    exists.exitCode === 0
      ? ["worktree", "add", targetPath, branch]
      : ["worktree", "add", targetPath, "-b", branch, defaultBranch];

  const res = await git.exec(args, repoRoot);
  if (res.exitCode !== 0) {
    throw new GitError(
      `git worktree add ${targetPath} failed: ${res.stderr.trim() || "unknown"}`,
    );
  }
  return targetPath;
}

/**
 * Ends a ticket stage. Prunes stale worktree metadata but KEEPS the worktree and
 * its branch on disk so the change remains available for review. The primary
 * checkout is left untouched.
 */
export async function finishTicketWorktree(
  git: GitRunner,
  repoRoot: string,
): Promise<void> {
  const inRepo = await git.exec(["rev-parse", "--git-dir"], repoRoot);
  if (inRepo.exitCode !== 0) return;
  await git.exec(["worktree", "prune"], repoRoot);
}

/**
 * Re-anchors the process back to the primary checkout after a stage ends
 * (move / cancel / fail). Prunes stale worktree metadata and chdirs out of the
 * ticket worktree so the next session starts from the repo root.
 */
export async function returnToRepoRoot(
  git: GitRunner,
  repoRoot: string,
): Promise<void> {
  await finishTicketWorktree(git, repoRoot);
  try {
    process.chdir(repoRoot);
  } catch {
    // Directory vanished (repo deleted mid-run) — nothing to re-anchor to.
  }
}
