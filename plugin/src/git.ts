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
  remote?: string | null;
  expectedSha?: string | null;
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
 * - Remote-tracking branch exists -> `git worktree add <path> -b <branch> <remote>/<branch>`
 *   (the workspace is reconstructed from the pushed handoff commit, on any machine).
 * - Local branch exists -> `git worktree add <path> <branch>`.
 * - Branch is new -> `git worktree add <path> -b <branch> <defaultBranch>` (branches
 *   from the default, never from the primary checkout's possibly-dirty HEAD).
 * - Branch is missing but `expectedSha` is set -> throw: the ticket has history we
 *   cannot reach, and silently restarting from the default branch would redo it.
 *
 * NEVER uses `-f`: a dirty worktree is EXPECTED uncommitted agent work, kept for
 * review. Each ticket gets its own worktree so tickets can never dirty-block one
 * another.
 */
export async function prepareTicketWorktree(
  git: GitRunner,
  opts: PrepareOpts,
): Promise<string> {
  const { repoRoot, branch, defaultBranch, ticket, remote, expectedSha } = opts;

  const inRepo = await git.exec(["rev-parse", "--git-dir"], repoRoot);
  if (inRepo.exitCode !== 0) return repoRoot;

  const targetPath = worktreePathFor(repoRoot, ticket);

  const list = await git.exec(["worktree", "list", "--porcelain"], repoRoot);
  if (list.exitCode === 0 && listHasPath(list.stdout, targetPath)) {
    return targetPath;
  }

  // Fetch the branch so a stage that completed on another machine can be
  // reconstructed here. Failure is ignored — the branch may not exist yet.
  if (remote) {
    await git.exec(["fetch", remote, branch], repoRoot);
  }

  let args: string[] | null = null;

  // Prefer the remote-tracking branch: it carries the committed handoff state.
  if (remote) {
    const remoteExists = await git.exec(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
      repoRoot,
    );
    if (remoteExists.exitCode === 0) {
      args = ["worktree", "add", targetPath, "-b", branch, `${remote}/${branch}`];
    }
  }

  if (args === null) {
    const exists = await git.exec(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repoRoot,
    );
    if (exists.exitCode === 0) {
      args = ["worktree", "add", targetPath, branch];
    } else if (expectedSha != null) {
      throw new GitError(
        `ticket branch '${branch}' not found locally or on remote '${
          remote ?? "(none)"
        }', but the ticket has a recorded head ${expectedSha} — refusing to restart from ${defaultBranch}`,
      );
    } else {
      args = ["worktree", "add", targetPath, "-b", branch, defaultBranch];
    }
  }

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

/** True when the worktree has uncommitted changes (tracked or untracked). */
export async function isDirty(git: GitRunner, worktree: string): Promise<boolean> {
  const res = await git.exec(["status", "--porcelain"], worktree);
  return res.stdout.trim() !== "";
}

/**
 * Commits every change in the worktree (tracked + untracked via `add -A`) with a
 * deterministic identity, so `git log` shows which agent ran which stage and the
 * commit cannot fail on a box with no git config.
 *
 * Returns the commit SHA, or `null` when the tree was already clean. Pre-commit
 * hooks are NOT bypassed — a hook failure throws a `GitError` carrying the hook
 * stderr, so a secret never quietly lands in history.
 */
export async function commitStage(
  git: GitRunner,
  opts: {
    worktree: string;
    ticket: string;
    column: string;
    label: string;
    note?: string;
  },
): Promise<string | null> {
  if (!(await isDirty(git, opts.worktree))) return null;

  const add = await git.exec(["add", "-A"], opts.worktree);
  if (add.exitCode !== 0) {
    throw new GitError(`git add -A failed: ${add.stderr.trim() || "unknown"}`);
  }

  const message = opts.note
    ? `[${opts.ticket}] ${opts.column}\n\n${opts.note}`
    : `[${opts.ticket}] ${opts.column}`;

  const commit = await git.exec(
    [
      "-c",
      `user.name=almadel[${opts.label}]`,
      "-c",
      "user.email=agent@almadel.local",
      "commit",
      "-m",
      message,
    ],
    opts.worktree,
  );
  if (commit.exitCode !== 0) {
    throw new GitError(`commit failed: ${commit.stderr.trim() || "unknown"}`);
  }

  return headSha(git, opts.worktree);
}

/** Resolves the current HEAD SHA in a worktree. */
export async function headSha(git: GitRunner, worktree: string): Promise<string> {
  const res = await git.exec(["rev-parse", "HEAD"], worktree);
  if (res.exitCode !== 0) {
    throw new GitError(`rev-parse HEAD failed: ${res.stderr.trim() || "unknown"}`);
  }
  return res.stdout.trim();
}

/** Pushes a branch to a remote. Throws `GitError` on failure. */
export async function pushBranch(
  git: GitRunner,
  worktree: string,
  remote: string,
  branch: string,
): Promise<void> {
  const res = await git.exec(["push", remote, branch], worktree);
  if (res.exitCode !== 0) {
    throw new GitError(
      `git push ${remote} ${branch} failed: ${res.stderr.trim() || "unknown"}`,
    );
  }
}
