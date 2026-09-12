import { describe, expect, test } from "bun:test"
import { Store } from "@/api/mock/store"

function fresh() {
  return new Store()
}

describe("Store.roster", () => {
  test("computes needs_you from blocked tickets", () => {
    const store = fresh()
    const roster = store.roster()
    expect(roster.needs_you).toBe(1)
  })

  test("groups agents by project and derives online", () => {
    const store = fresh()
    const roster = store.roster()
    const api = roster.projects.find((p) => p.project.id === "almadel-api")
    expect(api).toBeTruthy()
    // Gabriel has an old last_poll → offline
    const gabriel = api!.agents.find((a) => a.name === "Gabriel")
    expect(gabriel?.online).toBe(false)
    const alimiel = api!.agents.find((a) => a.name === "Alimiel")
    expect(alimiel?.online).toBe(true)
  })

  test("floats blocked agents to the top of their group", () => {
    const store = fresh()
    const api = store.roster().projects.find((p) => p.project.id === "almadel-api")!
    expect(api.agents[0].name).toBe("Gediel")
  })
})

describe("Store.board", () => {
  test("returns columns ordered by position", () => {
    const store = fresh()
    const board = store.board("almadel-api")
    const names = board.columns.map((c) => c.name)
    expect(names).toEqual(["Spec", "Planning", "Review", "Implement", "Testing", "Done", "Failed"])
  })

  test("returns tickets sorted by priority desc then created_at asc", () => {
    const store = fresh()
    const board = store.board("almadel-api")
    const first = board.tickets[0]
    expect(first.priority).toBeGreaterThanOrEqual(0)
    // Priority 2 ticket (TCK-412) should be first among those with highest priority
    expect(board.tickets.some((t) => t.id === "TCK-412")).toBe(true)
  })

  test("throws on unknown project", () => {
    const store = fresh()
    expect(() => store.board("nope")).toThrow("project not found")
  })
})

describe("Store.thread", () => {
  test("returns comments sorted and the open question", () => {
    const store = fresh()
    const thread = store.thread("TCK-418")
    expect(thread.question?.body).toContain("auth backend")
    expect(thread.comments.length).toBeGreaterThan(0)
    expect(thread.comments[0].kind).toBe("question")
  })

  test("throws on unknown ticket", () => {
    const store = fresh()
    expect(() => store.thread("nope")).toThrow("ticket not found")
  })
})

describe("Store.createTicket", () => {
  test("creates a ready ticket with a fresh id", () => {
    const store = fresh()
    store.createTicket("almadel-api", "New thing", "", "col-spec")
    const created = store.tickets.find((t) => t.title === "New thing")
    expect(created).toBeTruthy()
    expect(created!.state).toBe("ready")
    expect(created!.id).toMatch(/^TCK-\d+$/)
  })
})

describe("Store.moveTicket", () => {
  test("moves into a gate column sets done", () => {
    const store = fresh()
    store.moveTicket("TCK-405", "col-done")
    const t = store.tickets.find((t) => t.id === "TCK-405")!
    expect(t.column_id).toBe("col-done")
    expect(t.state).toBe("done")
    expect(t.agent_id).toBeNull()
  })

  test("moves into a prompted column sets ready", () => {
    const store = fresh()
    store.moveTicket("TCK-405", "col-implement")
    const t = store.tickets.find((t) => t.id === "TCK-405")!
    expect(t.state).toBe("ready")
  })

  test("adds a move comment", () => {
    const store = fresh()
    store.moveTicket("TCK-405", "col-done", "all good")
    const comments = store.comments.filter((c) => c.ticket_id === "TCK-405")
    expect(comments.some((c) => c.body === "moved to Done: all good")).toBe(true)
  })

  test("rejects a move to another project's column", () => {
    const store = fresh()
    expect(() => store.moveTicket("TCK-405", "web-col-build")).toThrow("out of scope")
  })

  test("rejects a move that would exceed a WIP limit", () => {
    const store = fresh()
    // Fill Planning (wip_limit 2) with two running tickets.
    const plan = store.columns.find((c) => c.name === "Planning")!
    store.tickets.push(
      { ...store.tickets[0], id: "TCK-X1", column_id: plan.id, state: "running" },
      { ...store.tickets[0], id: "TCK-X2", column_id: plan.id, state: "running" },
    )
    expect(() => store.moveTicket("TCK-405", plan.id)).toThrow("wip_limit")
  })
})

describe("Store.reply", () => {
  test("answering a blocked question resumes the ticket", () => {
    const store = fresh()
    store.reply("TCK-418", "Use JWT")
    const t = store.tickets.find((t) => t.id === "TCK-418")!
    expect(t.state).toBe("running")
    expect(store.questions.find((q) => q.ticket_id === "TCK-418")!.answer).toBe("Use JWT")
    const agent = store.agents.find((a) => a.ticket_id === "TCK-418")!
    expect(agent.status).toBe("working")
  })

  test("messaging a running ticket queues a pending message", () => {
    const store = fresh()
    store.reply("TCK-412", "heads up")
    const pending = store.pending.filter((p) => p.ticket_id === "TCK-412")
    expect(pending.length).toBe(1)
    expect(pending[0].sent_at).toBeNull()
  })
})

describe("Store.decidePermission", () => {
  test("records the decision and resumes the ticket", () => {
    const store = fresh()
    store.simulatePermission("TCK-412", "git push origin")
    store.decidePermission("TCK-412", "allow", "once")
    const t = store.tickets.find((t) => t.id === "TCK-412")!
    expect(t.state).toBe("running")
    const perm = store.permissions.find((p) => p.ticket_id === "TCK-412")!
    expect(perm.decision).toBe("allow")
    expect(perm.scope).toBe("once")
  })
})

describe("Store.cancelTicket", () => {
  test("fails the ticket and clears the agent", () => {
    const store = fresh()
    store.cancelTicket("TCK-412")
    const t = store.tickets.find((t) => t.id === "TCK-412")!
    expect(t.state).toBe("failed")
    expect(t.agent_id).toBeNull()
  })
})

describe("Store.takeoverTicket", () => {
  test("marks human-owned and returns to ready", () => {
    const store = fresh()
    store.takeoverTicket("TCK-412")
    const t = store.tickets.find((t) => t.id === "TCK-412")!
    expect(t.agent_id).toBeNull()
    expect(t.state).toBe("ready")
  })
})

describe("Store.updateColumns", () => {
  test("replaces columns for the project only", () => {
    const store = fresh()
    const before = store.columns.filter((c) => c.project_id === "almadel-web").length
    store.updateColumns("almadel-api", [
      { id: "col-a", name: "A" },
      { id: "col-b", name: "B" },
    ] as never[])
    const apiCols = store.columns.filter((c) => c.project_id === "almadel-api")
    expect(apiCols.map((c) => c.name)).toEqual(["A", "B"])
    expect(store.columns.filter((c) => c.project_id === "almadel-web").length).toBe(before)
  })

  test("round-trips the model field, defaulting to null", () => {
    const store = fresh()
    store.updateColumns("almadel-api", [
      { id: "col-a", name: "A", model: "anthropic/claude-opus-4-1" },
      { id: "col-b", name: "B" },
    ] as never[])
    const cols = store.columns.filter((c) => c.project_id === "almadel-api")
    expect(cols[0].model).toBe("anthropic/claude-opus-4-1")
    expect(cols[1].model).toBeNull()
  })
})

describe("Store.simulateQuestion", () => {
  test("blocks a ticket and creates a question", () => {
    const store = fresh()
    store.simulateQuestion("TCK-412", "which port?")
    const t = store.tickets.find((t) => t.id === "TCK-412")!
    expect(t.state).toBe("blocked_question")
    expect(store.questions.some((q) => q.ticket_id === "TCK-412")).toBe(true)
  })
})
