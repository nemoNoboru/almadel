import { describe, expect, test } from "bun:test";
import { askQuestion, NO_ANSWER_MESSAGE } from "../../src/ask.ts";
import { createState } from "../../src/state.ts";
import type { AlmadelClient } from "../../src/http.ts";

describe("askQuestion", () => {
  test("fast path returns the answer", async () => {
    const client = {
      ask: async () => ({ id: "q1" }),
      pollQuestion: async () => ({ answer: "yes" }),
    } as unknown as AlmadelClient;
    const state = createState();
    expect(await askQuestion(client, state, "t1", "proceed?")).toBe("yes");
  });

  test("slow path (204 null) returns NO_ANSWER_MESSAGE", async () => {
    const client = {
      ask: async () => ({ id: "q1" }),
      pollQuestion: async () => null,
    } as unknown as AlmadelClient;
    const state = createState();
    expect(await askQuestion(client, state, "t1", "proceed?")).toBe(
      NO_ANSWER_MESSAGE,
    );
  });
});
