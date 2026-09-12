import { describe, expect, test } from "bun:test";
import { makeAlmadelTools, type ToolDeps } from "../../src/tools.ts";
import { createState } from "../../src/state.ts";
import type { AlmadelClient } from "../../src/http.ts";

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    client: {} as unknown as AlmadelClient,
    state: createState(),
    git: {} as never,
    repoRoot: "/tmp",
    getBoard: async () => [
      { id: "col-spec", name: "Spec", prompt: null },
      { id: "col-implement", name: "Implement", prompt: "do it" },
      { id: "col-review", name: "Review", prompt: null },
    ],
    enlist: async () => "",
    leave: async () => "",
    status: async () => "",
    ...overrides,
  };
}

describe("almadel_create_ticket", () => {
  test("posts to /api/tickets with a manual column and returns the id", async () => {
    const calls: Array<{ projectId: string; input: unknown }> = [];
    const client = {
      createTicket: async (projectId: string, input: unknown) => {
        calls.push({ projectId, input });
        return { id: "TCK-999" };
      },
    } as unknown as AlmadelClient;
    const state = createState();
    state.projectId = "almadel-api";

    const tools = await makeAlmadelTools(deps({ client, state }));
    const result = await tools.almadel_create_ticket.execute({
      title: "subtask",
      body: "do x",
      column: "col-spec",
    });

    expect(result).toBe("created ticket TCK-999");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.projectId).toBe("almadel-api");
    expect(calls[0]!.input).toEqual({ title: "subtask", body: "do x", column_id: "col-spec" });
  });

  test("column enum only contains manual columns", async () => {
    const tools = await makeAlmadelTools(deps());
    const colEnum = tools.almadel_create_ticket.args.column;
    expect(colEnum.safeParse("col-spec").success).toBe(true);
    expect(colEnum.safeParse("col-review").success).toBe(true);
    expect(colEnum.safeParse("col-implement").success).toBe(false);
  });

  test("returns a message when not joined to a server", async () => {
    const tools = await makeAlmadelTools(deps());
    expect(await tools.almadel_create_ticket.execute({ title: "x", column: "col-spec" })).toBe(
      "not joined to an Almadel server",
    );
  });
});
