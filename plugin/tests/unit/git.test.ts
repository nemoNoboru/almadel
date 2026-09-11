import { describe, expect, test } from "bun:test";
import { checkoutBranch, GitError } from "../../src/git.ts";
import type { GitRunner } from "../../src/git.ts";

function gitFor(outputs: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  return {
    exec: async (args: string[]) => {
      const key = args.join(" ");
      return outputs[key] ?? { stdout: "", stderr: "", exitCode: 0 };
    },
  } as GitRunner;
}

describe("checkoutBranch", () => {
  test("is a no-op when already on the target branch (dirty tree allowed)", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "rev-parse" && args[1] === "--git-dir") {
          return { stdout: "/d/.git", stderr: "", exitCode: 0 };
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return { stdout: "run/1", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as GitRunner;
    await checkoutBranch(git, "run/1", "/d");
    expect(calls).toEqual(["rev-parse --git-dir", "rev-parse --abbrev-ref HEAD"]);
  });

  test("is a no-op when the directory is not a git repository", async () => {
    const calls: string[] = [];
    const git = {
      exec: async (args: string[]) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
      },
    } as GitRunner;
    await checkoutBranch(git, "run/1", "/d");
    expect(calls).toEqual(["rev-parse --git-dir"]);
  });

  test("refuses on a dirty worktree when switching (never -f)", async () => {
    const git = gitFor({
      "rev-parse --abbrev-ref HEAD": { stdout: "main", exitCode: 0 },
      "status --porcelain": { stdout: "M file.ts", exitCode: 0 },
    });
    await expect(checkoutBranch(git, "run/1", "/d")).rejects.toThrow(/dirty/);
  });

  test("creates the branch on a clean tree when it does not exist", async () => {
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
    await checkoutBranch(git, "run/1", "/d");
    expect(calls).toContain("checkout -b run/1");
    expect(calls.some((c) => c.includes("-f"))).toBe(false);
  });

  test("checks out an existing branch on a clean tree", async () => {
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
    await checkoutBranch(git, "run/1", "/d");
    expect(calls).toContain("checkout run/1");
    expect(calls).not.toContain("checkout -b run/1");
  });

  test("surfaces git failure", async () => {
    const git = gitFor({
      "rev-parse --abbrev-ref HEAD": { stdout: "main", exitCode: 0 },
      "status --porcelain": { stdout: "", exitCode: 0 },
      "rev-parse --verify --quiet refs/heads/run/1": { stdout: "", stderr: "", exitCode: 1 },
      "checkout -b run/1": { stdout: "", stderr: "boom", exitCode: 128 },
    });
    await expect(checkoutBranch(git, "run/1", "/d")).rejects.toThrow(GitError);
  });
});
