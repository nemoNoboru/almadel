import { describe, expect, test } from "bun:test";
import { JobSchema, PermissionRequestSchema, moveTicketSchema } from "../../src/types.ts";
import { columnEnum } from "../../src/tools.ts";
import { z } from "zod";

describe("JobSchema", () => {
  test("parses a task job", () => {
    const job = {
      type: "task",
      project: "p1",
      ticket: "t1",
      prompt: "do it",
      branch: "run/t1",
    };
    expect(JobSchema.parse(job).type).toBe("task");
  });

  test("parses a reply job", () => {
    const job = JobSchema.parse({ type: "reply", project: "p", ticket: "t", text: "hi" });
    expect(job.type === "reply" && job.text).toBe("hi");
  });

  test("parses a permission job", () => {
    const job = JobSchema.parse({
      type: "permission",
      project: "p",
      ticket: "t",
      permission_id: "x",
      decision: "allow",
      scope: "once",
    });
    expect(job.type === "permission" && job.decision).toBe("allow");
  });

  test("rejects unknown job type", () => {
    expect(JobSchema.safeParse({ type: "nope" }).success).toBe(false);
  });
});

describe("moveTicketSchema", () => {
  test("note capped at 2000", () => {
    expect(moveTicketSchema.safeParse({ column: "c", note: "x".repeat(2001) }).success).toBe(false);
    expect(moveTicketSchema.safeParse({ column: "c", note: "x".repeat(2000) }).success).toBe(true);
  });
});

describe("columnEnum", () => {
  test("off-board column is structurally impossible", () => {
    const e = columnEnum([{ id: "a", name: "Planning" }, { id: "b", name: "Done" }]);
    expect(e.safeParse("a").success).toBe(true);
    expect(e.safeParse("zzz").success).toBe(false);
  });

  test("empty board falls back to a no-op enum", () => {
    const e = columnEnum([]);
    expect(e.safeParse("anything").success).toBe(false);
  });
});

describe("PermissionRequestSchema", () => {
  test("parses runtime 1.18.30 shape", () => {
    const parsed = PermissionRequestSchema.parse({
      id: "perm-1",
      sessionID: "sess-1",
      permission: "bash",
      patterns: ["ls"],
      metadata: { foo: 1 },
      always: [],
      tool: { messageID: "m1", callID: "c1" },
    });
    expect(parsed.permission).toBe("bash");
    expect(parsed.tool?.callID).toBe("c1");
  });
});
