import { describe, expect, test } from "bun:test";
import { decidePermission } from "../../src/permission.ts";
import { createState } from "../../src/state.ts";
import type { AlmadelClient } from "../../src/http.ts";
import type { PermissionRequest } from "../../src/types.ts";

function clientFor(result: unknown): AlmadelClient {
  return {
    requestPermission: async () => result,
  } as unknown as AlmadelClient;
}

function req(permission: string, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "p1",
    sessionID: "s1",
    permission,
    patterns: [],
    metadata: {},
    always: [],
    ...overrides,
  };
}

describe("decidePermission", () => {
  test("read-only never escalates", async () => {
    const state = createState();
    state.currentTicket = "t1";
    const c = clientFor({ decision: "deny", scope: "once" });
    const r = await decidePermission(c, state, req("read"));
    expect(r.response).toBe("always");
  });

  test("no ticket held -> reject", async () => {
    const state = createState();
    const c = clientFor({ decision: "allow", scope: "always" });
    const r = await decidePermission(c, state, req("bash"));
    expect(r.response).toBe("reject");
  });

  test("allow+once maps to once", async () => {
    const state = createState();
    state.currentTicket = "t1";
    const c = clientFor({ decision: "allow", scope: "once" });
    expect((await decidePermission(c, state, req("bash"))).response).toBe("once");
  });

  test("allow+always maps to always", async () => {
    const state = createState();
    state.currentTicket = "t1";
    const c = clientFor({ decision: "allow", scope: "session" });
    expect((await decidePermission(c, state, req("bash"))).response).toBe("always");
  });

  test("deny maps to reject", async () => {
    const state = createState();
    state.currentTicket = "t1";
    const c = clientFor({ decision: "deny", scope: "once" });
    expect((await decidePermission(c, state, req("bash"))).response).toBe("reject");
  });

  test("timeout maps to reject", async () => {
    const state = createState();
    state.currentTicket = "t1";
    const c = clientFor({ decision: "deny", scope: "once", timeout: true });
    expect((await decidePermission(c, state, req("bash"))).response).toBe("reject");
  });
});
