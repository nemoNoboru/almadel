import { describe, expect, test } from "bun:test";
import {
  prepareTicketWorktree,
  finishTicketWorktree,
  worktreePathFor,
  commitStage,
  isDirty,
  headSha,
  pushBranch,
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

describe("prepareTicketWorktree remote/expectedSha", () => {
  test("prefers the remote-tracking branch over defaultBranch", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "rev-parse" && args[1] === "--git-dir") {
          return { stdout: ".git", stderr: "", exitCode: 0 };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: "worktree /repo\n", stderr: "", exitCode: 0 };
        }
        if (args.join(" ").includes("refs/remotes/origin/run/1")) {
          return { stdout: "abc123", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await expect(
      prepareTicketWorktree(git, { ...opts, remote: "origin" }),
    ).resolves.toBe(target);
    expect(calls).toContain("fetch origin run/1");
    expect(calls).toContain(`worktree add ${target} -b run/1 origin/run/1`);
    expect(calls.some((c) => c.includes("main"))).toBe(false);
  });

  test("throws rather than restarting from defaultBranch when expectedSha is set", async () => {
    const git = {
      exec: async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir") {
          return { stdout: ".git", stderr: "", exitCode: 0 };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: "worktree /repo\n", stderr: "", exitCode: 0 };
        }
        if (args.join(" ").includes("refs/remotes/origin/run/1")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        if (args.join(" ").includes("refs/heads/run/1")) {
          return { stdout: "", stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await expect(
      prepareTicketWorktree(git, {
        ...opts,
        remote: "origin",
        expectedSha: "deadbeef",
      }),
    ).rejects.toThrow(GitError);
  });
});

describe("commitStage", () => {
  const commitOpts = {
    worktree: "/wt",
    ticket: "TCK-1",
    column: "done",
    label: "laptop",
  };

  test("returns null and issues no commit when the tree is clean", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    const sha = await commitStage(git, commitOpts);
    expect(sha).toBeNull();
    expect(calls.some((c) => c.includes("commit"))).toBe(false);
  });

  test("sets identity flags on every invocation", async () => {
    const git = {
      exec: async (args: string[]) => {
        if (args[0] === "status") return { stdout: "M f", stderr: "", exitCode: 0 };
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { stdout: "abc123", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    const sha = await commitStage(git, commitOpts);
    expect(sha).toBe("abc123");
  });

  test("issues add + commit with identity flags", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "status") return { stdout: "M f", stderr: "", exitCode: 0 };
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { stdout: "abc123", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await commitStage(git, commitOpts);
    expect(calls).toContain("add -A");
    const commitCall = calls.find((c) => c.includes(" commit "));
    expect(commitCall).toBeDefined();
    expect(commitCall).toContain("-c user.name=almadel[laptop]");
    expect(commitCall).toContain("-c user.email=agent@almadel.local");
  });

  test("raises GitError carrying hook stderr when a pre-commit hook fails", async () => {
    const git = {
      exec: async (args: string[]) => {
        if (args[0] === "status") return { stdout: "M f", stderr: "", exitCode: 0 };
        if (args[0] === "add") return { stdout: "", stderr: "", exitCode: 0 };
        if (args.includes("commit")) {
          return { stdout: "", stderr: "gitleaks: found secrets", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await expect(commitStage(git, commitOpts)).rejects.toThrow(
      /gitleaks: found secrets/,
    );
  });
});

describe("isDirty / headSha / pushBranch", () => {
  test("isDirty reflects porcelain output", async () => {
    expect(
      await isDirty(
        { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as GitRunner,
        "/wt",
      ),
    ).toBe(false);
    expect(
      await isDirty(
        { exec: async () => ({ stdout: " M a.ts\n", stderr: "", exitCode: 0 }) } as GitRunner,
        "/wt",
      ),
    ).toBe(true);
  });

  test("headSha trims the rev", async () => {
    const git = {
      exec: async () => ({ stdout: "abc123\n", stderr: "", exitCode: 0 }),
    } as GitRunner;
    expect(await headSha(git, "/wt")).toBe("abc123");
  });

  test("pushBranch throws GitError on failure", async () => {
    const git = {
      exec: async () => ({ stdout: "", stderr: "rejected", exitCode: 1 }),
    } as GitRunner;
    await expect(pushBranch(git, "/wt", "origin", "run/1")).rejects.toThrow(GitError);
  });
});
