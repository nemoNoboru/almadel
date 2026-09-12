import { describe, expect, test } from "bun:test";
import { ColumnSchema, JobSchema, PermissionRequestSchema, moveTicketSchema } from "../../src/types.ts";
import { columnEnum } from "../../src/tools.ts";
import { parseModel } from "../../src/index.ts";
import { z } from "zod";

describe("JobSchema", () => {
  test("parses a task job", () => {
    const job = {
      type: "task",
      project: "p1",
      ticket: "t1",
      prompt: "do it",
      branch: "run/t1",
      model: "anthropic/claude-opus-4-1",
      base_sha: null,
    };
    const parsed = JobSchema.parse(job);
    expect(parsed.type).toBe("task");
    if (parsed.type === "task") expect(parsed.model).toBe("anthropic/claude-opus-4-1");
  });

  test("parses a task job with a null model", () => {
    const job = JobSchema.parse({
      type: "task",
      project: "p",
      ticket: "t",
      prompt: "do it",
      branch: "run/t",
      model: null,
      base_sha: "deadbeef",
    });
    expect(job.type === "task" && job.model).toBeNull();
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

describe("ColumnSchema", () => {
  test("accepts a null model", () => {
    const col = ColumnSchema.parse({
      id: "col-1",
      project_id: "p",
      name: "Planning",
      prompt: null,
      model: null,
      position: 0,
    });
    expect(col.model).toBeNull();
  });

  test("accepts a pinned model", () => {
    const col = ColumnSchema.parse({
      id: "col-1",
      project_id: "p",
      name: "Implement",
      prompt: "x",
      model: "anthropic/claude-opus-4-1",
      position: 1,
    });
    expect(col.model).toBe("anthropic/claude-opus-4-1");
  });
});

describe("parseModel", () => {
  test("splits a ref on the first slash", () => {
    expect(parseModel("anthropic/claude-opus-4-1")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-1",
    });
  });

  test("handles a ref without a slash", () => {
    expect(parseModel("claude-opus-4-1")).toEqual({ providerID: "claude-opus-4-1", modelID: "" });
  });

  test("returns undefined for null", () => {
    expect(parseModel(null)).toBeUndefined();
  });
});

describe("columnEnum", () => {
  test("off-board column is structurally impossible", () => {
    const e = columnEnum([
      { id: "a", name: "Planning", prompt: null },
      { id: "b", name: "Done", prompt: null },
    ]);
    expect(e.safeParse("Planning").success).toBe(true);
    expect(e.safeParse("a").success).toBe(false);
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
