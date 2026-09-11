import { describe, expect, test } from "bun:test";
import {
  prepareTicketWorktree,
  finishTicketWorktree,
  worktreePathFor,
  GitError,
} from "../../src/git.ts";
import type { GitRunner } from "../../src/git.ts";

function gitFor(outputs: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  return {
    exec: async (args: string[]) => {
      const key = args.join(" ");
      return outputs[key] ?? { stdout: "", stderr: "", exitCode: 0 };
    },
  } as GitRunner;
}

const opts = {
  repoRoot: "/repo",
  branch: "run/1",
  defaultBranch: "main",
  ticket: "TCK-1",
};
const target = worktreePathFor("/repo", "TCK-1");

describe("worktreePathFor", () => {
  test("nests under .almadel/wt inside the repo root", () => {
    expect(worktreePathFor("/repo", "TCK-418")).toBe("/repo/.almadel/wt/TCK-418");
  });
});

describe("prepareTicketWorktree", () => {
  test("works in place when the directory is not a git repository", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
      },
    } as GitRunner;
    await expect(prepareTicketWorktree(git, opts)).resolves.toBe("/repo");
    expect(calls).toEqual(["rev-parse --git-dir"]);
  });

  test("reclaims an existing worktree (idempotent re-claim)", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "worktree" && args[1] === "list") {
          return {
            stdout: `worktree /repo\nHEAD abc\n\nworktree ${target}\nbranch refs/heads/run/1\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await expect(prepareTicketWorktree(git, opts)).resolves.toBe(target);
    expect(calls).toEqual([
      "rev-parse --git-dir",
      "worktree list --porcelain",
    ]);
  });

  test("creates a new branch from the default branch (never -f)", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await expect(prepareTicketWorktree(git, opts)).resolves.toBe(target);
    expect(calls).toContain(`worktree add ${target} -b run/1 main`);
    expect(calls.some((c) => c.includes("-f"))).toBe(false);
  });

  test("checks out an existing branch in a fresh worktree", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "rev-parse" && args[1] === "--verify") {
          return { stdout: "abc123", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await expect(prepareTicketWorktree(git, opts)).resolves.toBe(target);
    expect(calls).toContain(`worktree add ${target} run/1`);
    expect(calls).not.toContain(`worktree add ${target} -b run/1 main`);
  });

  test("surfaces git failure as a GitError", async () => {
    const git = gitFor({
      "rev-parse --verify --quiet refs/heads/run/1": { stdout: "", stderr: "", exitCode: 1 },
      [`worktree add ${target} -b run/1 main`]: { stdout: "", stderr: "boom", exitCode: 128 },
    });
    await expect(prepareTicketWorktree(git, opts)).rejects.toThrow(GitError);
  });
});

describe("finishTicketWorktree", () => {
  test("is a no-op when not a git repository", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "fatal", exitCode: 128 };
      },
    } as GitRunner;
    await finishTicketWorktree(git, "/repo");
    expect(calls).toEqual(["rev-parse --git-dir"]);
  });

  test("prunes stale worktree metadata but keeps the worktree", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await finishTicketWorktree(git, "/repo");
    expect(calls).toEqual(["rev-parse --git-dir", "worktree prune"]);
  });
});
