import { describe, expect, test } from "bun:test";
import { makeAlmadelTools } from "../../src/tools.ts";
import { createState } from "../../src/state.ts";
import type { AlmadelClient } from "../../src/http.ts";
import type { GitRunner } from "../../src/git.ts";

function gitFor(handler: (args: string[]) => { stdout?: string; stderr?: string; exitCode?: number }) {
  return {
    exec: async (args: string[]) => handler(args),
  } as GitRunner;
}

const deps = (client: AlmadelClient, state: ReturnType<typeof createState>, git: GitRunner) =>
  makeAlmadelTools({
    client,
    state,
    git,
    repoRoot: "/repo",
    label: "laptop",
    gitRemote: "https://example.com/repo.git",
    getBoard: async () => [{ id: "done", name: "Done" }],
    enlist: async () => "",
    leave: async () => "",
    status: async () => "",
  });

describe("almadel_move", () => {
  test("commits, pushes, then moves, in order", async () => {
    const ops: string[] = [];
    const git = gitFor((args) => {
      ops.push(`git ${args.join(" ")}`);
      if (args[0] === "status") return { stdout: " M file.ts", stderr: "", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const state = createState();
    state.currentTicket = "TCK-1";
    state.currentWorktree = "/repo/.almadel/wt/TCK-1";
    state.currentBranch = "run/TCK-1";
    const client = {
      move: async (_id: string, input: unknown) => {
        ops.push(`move ${JSON.stringify(input)}`);
      },
      comment: async () => {},
    } as unknown as AlmadelClient;

    const tools = await deps(client, state, git);
    const result = await tools.almadel_move.execute({ column: "done" });
    expect(result).toBe("ticket moved; stage complete");

    const addIdx = ops.findIndex((o) => o === "git add -A");
    const commitIdx = ops.findIndex((o) => o.includes(" commit "));
    const pushIdx = ops.findIndex((o) => o.includes("push origin run/TCK-1"));
    const moveIdx = ops.findIndex((o) => o.startsWith("move "));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(pushIdx).toBeGreaterThan(commitIdx);
    expect(moveIdx).toBeGreaterThan(pushIdx);
    expect(ops[moveIdx] ?? "").toContain('"head_sha":"abc123"');
  });

  test("aborts the move when commit throws, leaving the ticket in place", async () => {
    let moved = false;
    const comments: unknown[] = [];
    const git = gitFor((args) => {
      if (args[0] === "status") return { stdout: " M file.ts", stderr: "", exitCode: 0 };
      if (args.includes("commit")) {
        return { stdout: "", stderr: "gitleaks: found secrets", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const state = createState();
    state.currentTicket = "TCK-1";
    state.currentWorktree = "/repo/.almadel/wt/TCK-1";
    state.currentBranch = "run/TCK-1";
    const client = {
      move: async () => {
        moved = true;
      },
      comment: async (_id: string, input: unknown) => {
        comments.push(input);
      },
    } as unknown as AlmadelClient;

    const tools = await deps(client, state, git);
    const result = await tools.almadel_move.execute({ column: "done" });
    expect(moved).toBe(false);
    expect(comments.length).toBe(1);
    expect(result).toContain("move aborted");
  });

  test("does not push when there is nothing to commit", async () => {
    const ops: string[] = [];
    const git = gitFor((args) => {
      ops.push(`git ${args.join(" ")}`);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const state = createState();
    state.currentTicket = "TCK-1";
    state.currentWorktree = "/repo/.almadel/wt/TCK-1";
    state.currentBranch = "run/TCK-1";
    const client = {
      move: async (_id: string, input: unknown) => {
        ops.push(`move ${JSON.stringify(input)}`);
      },
      comment: async () => {},
    } as unknown as AlmadelClient;

    const tools = await deps(client, state, git);
    await tools.almadel_move.execute({ column: "done" });
    expect(ops.some((o) => o.includes("push"))).toBe(false);
    expect(ops.some((o) => o.startsWith("move "))).toBe(true);
  });
});
