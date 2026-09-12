import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { Config } from "../src/config"
import { migrate, seed } from "../src/db"
import { registerAgent } from "../src/domain/agents"
import { askQuestion, decidePermission, reply, requestPermission } from "../src/domain/blocking"
import { claimNow, makeTaskJob } from "../src/domain/claim"
import { sweep } from "../src/domain/lease"
import { roster, thread } from "../src/domain/roster"
import { board, cancelTicket, createProject, createTicket, getTicket, moveTicket, updateTicket } from "../src/domain/tickets"

function testDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA foreign_keys = ON;")
  migrate(db)
  seed(db)
  return db
}

const config: Config = {
  host: "127.0.0.1",
  port: 8787,
  dbPath: ":memory:",
  staticDir: null,
  pollWindowMs: 35_000,
  leaseTtlMs: 90_000,
  sweepIntervalMs: 15_000,
  askTimeoutMs: 5 * 60_000,
  permissionTtlMs: 60 * 60_000,
  portBase: 8000,
  portBandWidth: 100,
  minOpencodeVersion: "1.0.0",
}

describe("seeding", () => {
  test("creates the default project and board", () => {
    const db = testDb()
    const b = board(db, "almadel-api")!
    expect(b.project.id).toBe("almadel-api")
    expect(b.columns.map((c) => c.name)).toEqual(["Spec", "Planning", "Review", "Implement", "Testing", "Done", "Failed"])
  })
})

describe("createProject", () => {
  test("inserts a project with the default 7-column board", () => {
    const db = testDb()
    const p = createProject(db, { name: "acme", git_remote: "git@github.com:acme/acme.git" })
    expect(p.id).toMatch(/^prj_/)
    expect(p.name).toBe("acme")
    expect(p.git_remote).toBe("git@github.com:acme/acme.git")
    expect(p.default_branch).toBe("main")

    const b = board(db, p.id)!
    expect(b.columns.map((c) => c.name)).toEqual(["Spec", "Planning", "Review", "Implement", "Testing", "Done", "Failed"])
    expect(b.tickets).toEqual([])
  })

  test("defaults git_remote to null and default_branch to main", () => {
    const db = testDb()
    const p = createProject(db, { name: "no-remote" })
    expect(p.git_remote).toBeNull()
    expect(p.default_branch).toBe("main")
  })

  test("honors an explicit default_branch", () => {
    const db = testDb()
    const p = createProject(db, { name: "trunk", default_branch: "trunk" })
    expect(p.default_branch).toBe("trunk")
  })

  test("rejects a duplicate project name", () => {
    const db = testDb()
    expect(() => createProject(db, { name: "almadel-api" })).toThrow()
  })
})

describe("claim", () => {
  test("a ticket in a prompted column is claimed atomically", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api",
      repo_root: "/srv/slots/1",
      label: "laptop",
      opencode_version: "1.5.0",
      capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    const ticket = createTicket(db, {
      project_id: "almadel-api",
      title: "Add rate limiting",
      body: "token bucket",
      column_id: "col-implement",
    })
    expect(ticket.state).toBe("ready")

    const claimed = claimNow(db, "almadel-api", agent.agent_id)
    expect(claimed).not.toBeNull()
    expect(claimed!.state).toBe("running")
    expect(claimed!.branch).toBe(`run/${ticket.id}`)
    expect(claimed!.agent_id).toBe(agent.agent_id)

    // A second claim finds nothing (the ticket is now running).
    expect(claimNow(db, "almadel-api", agent.agent_id)).toBeNull()
  })

  test("a busy agent does not claim a second ticket", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api",
      repo_root: "/srv/slots/1",
      label: "laptop",
      opencode_version: "1.5.0",
      capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    createTicket(db, { project_id: "almadel-api", title: "first", column_id: "col-implement" })
    createTicket(db, { project_id: "almadel-api", title: "second", column_id: "col-implement" })

    const claimed = claimNow(db, "almadel-api", agent.agent_id)
    expect(claimed).not.toBeNull()

    // A second ready ticket exists, but the agent is still busy.
    expect(claimNow(db, "almadel-api", agent.agent_id)).toBeNull()
  })

  test("a non-idle agent with no held ticket does not claim a new task", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api",
      repo_root: "/srv/slots/1",
      label: "laptop",
      opencode_version: "1.5.0",
      capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    // After a move the agent holds no ticket, but its session is still
    // committing, so the slot reports "working" until it flips back to idle.
    db.query("UPDATE agents SET status = 'working', ticket_id = NULL WHERE id = ?").run(agent.agent_id)
    createTicket(db, { project_id: "almadel-api", title: "next", column_id: "col-implement" })

    expect(claimNow(db, "almadel-api", agent.agent_id)).toBeNull()

    // Once the session ends the slot is idle and can claim again.
    db.query("UPDATE agents SET status = 'idle', ticket_id = NULL WHERE id = ?").run(agent.agent_id)
    const claimed = claimNow(db, "almadel-api", agent.agent_id)
    expect(claimed).not.toBeNull()
    expect(claimed!.state).toBe("running")
  })

  test("a human-gate column is never claimed", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api",
      repo_root: "/srv/slots/1",
      label: "laptop",
      opencode_version: "1.5.0",
      capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    createTicket(db, { project_id: "almadel-api", title: "write a spec", column_id: "col-spec" })
    expect(claimNow(db, "almadel-api", agent.agent_id)).toBeNull()
  })

  test("the task job renders the prompt with the thread and port band", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api",
      repo_root: "/srv/slots/1",
      label: "laptop",
      opencode_version: "1.5.0",
      capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    const ticket = createTicket(db, { project_id: "almadel-api", title: "Add rate limiting", body: "token bucket", column_id: "col-planning" })
    claimNow(db, "almadel-api", agent.agent_id)
    const job = makeTaskJob(db, getTicket(db, ticket.id)!, agent.agent_id)
    expect(job.type).toBe("task")
    if (job.type === "task") {
      expect(job.prompt).toContain(ticket.id)
      expect(job.prompt).toContain("implementation plan")
      expect(job.branch).toBe(`run/${ticket.id}`)
    }
  })

  test("the task job carries the column model when pinned", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api",
      repo_root: "/srv/slots/1",
      label: "laptop",
      opencode_version: "1.5.0",
      capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    db.query("UPDATE columns SET model = ? WHERE id = ?").run("anthropic/claude-opus-4-1", "col-planning")
    const ticket = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-planning" })
    claimNow(db, "almadel-api", agent.agent_id)
    const job = makeTaskJob(db, getTicket(db, ticket.id)!, agent.agent_id)
    expect(job.type).toBe("task")
    if (job.type === "task") expect(job.model).toBe("anthropic/claude-opus-4-1")
  })

  test("the task job model is null when the column does not pin one", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api",
      repo_root: "/srv/slots/1",
      label: "laptop",
      opencode_version: "1.5.0",
      capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    const ticket = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-planning" })
    claimNow(db, "almadel-api", agent.agent_id)
    const job = makeTaskJob(db, getTicket(db, ticket.id)!, agent.agent_id)
    expect(job.type).toBe("task")
    if (job.type === "task") expect(job.model).toBeNull()
  })
})

describe("registration", () => {
  test("refuses a remote mismatch", () => {
    const db = testDb()
    // Give the project a remote.
    db.query("UPDATE projects SET git_remote = ? WHERE id = ?").run("git@github.com:me/api.git", "almadel-api")

    expect(() =>
      registerAgent(db, {
        project: "almadel-api",
        repo_root: "/srv/slots/1",
        git_remote: "git@github.com:evil/other.git",
        label: "laptop",
        opencode_version: "1.5.0",
        capabilities: { tools: true, permission_hook: true },
      }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 }),
    ).toThrow()
  })

  test("refuses an old opencode version", () => {
    const db = testDb()
    expect(() =>
      registerAgent(db, {
        project: "almadel-api",
        repo_root: "/srv/slots/1",
        label: "laptop",
        opencode_version: "0.9.4",
        capabilities: { tools: true, permission_hook: true },
      }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 }),
    ).toThrow()
  })

  test("upserts on (project_id, repo_root, label) and keeps the display name", () => {
    const db = testDb()
    const opts = { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 }
    const first = registerAgent(db, {
      project: "almadel-api", repo_root: "/srv/slots/1", label: "laptop",
      opencode_version: "1.5.0", capabilities: { tools: true, permission_hook: true },
    }, opts)
    const second = registerAgent(db, {
      project: "almadel-api", repo_root: "/srv/slots/1", label: "laptop",
      opencode_version: "1.5.0", capabilities: { tools: true, permission_hook: true },
    }, opts)

    expect(second.name).toBe(first.name)
    expect(second.port_base).toBe(first.port_base)
    expect(second.agent_id).toBe(first.agent_id)
    expect(second.token).not.toBe(first.token)

    const rows = db.query("SELECT count(*) AS n FROM agents WHERE project_id = 'almadel-api'").get() as { n: number }
    expect(rows.n).toBe(1)
  })
})

describe("move", () => {
  test("moving to a prompted column marks ready; to Done marks done", () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-spec" })
    expect(t.state).toBe("ready")

    const done = moveTicket(db, t.id, "col-done")
    expect(done.state).toBe("done")

    const failed = moveTicket(db, t.id, "col-failed")
    expect(failed.state).toBe("failed")
  })

  test("rejects a drop at the WIP limit", () => {
    const db = testDb()
    // Implement has wip_limit 2. Put two running tickets there, then a third move
    // should be rejected.
    const t1 = createTicket(db, { project_id: "almadel-api", title: "a", column_id: "col-implement" })
    const t2 = createTicket(db, { project_id: "almadel-api", title: "b", column_id: "col-implement" })
    const t3 = createTicket(db, { project_id: "almadel-api", title: "c", column_id: "col-spec" })

    db.query("UPDATE tickets SET state = 'running' WHERE id IN (?, ?)").run(t1.id, t2.id)

    expect(() => moveTicket(db, t3.id, "col-implement")).toThrow()
  })
})

describe("updateTicket", () => {
  test("persists title and body", () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "old", body: "body", column_id: "col-spec" })
    const updated = updateTicket(db, t.id, { title: "new", body: "new body" })
    expect(updated.title).toBe("new")
    expect(updated.body).toBe("new body")
    expect(getTicket(db, t.id)!.title).toBe("new")
  })

  test("404s for an unknown ticket", () => {
    const db = testDb()
    expect(() => updateTicket(db, "nope", { title: "x" })).toThrow()
  })
})

describe("ask / reply", () => {
  test("an answer resolves a blocked question and moves the ticket back to running", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api", repo_root: "/srv/slots/1", label: "laptop",
      opencode_version: "1.5.0", capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    const t = createTicket(db, { project_id: "almadel-api", title: "q", column_id: "col-implement" })
    claimNow(db, "almadel-api", agent.agent_id)

    const qid = askQuestion(db, t.id, "which backend?")
    expect(getTicket(db, t.id)!.state).toBe("blocked_question")

    reply(db, t.id, "use JWT")
    expect(getTicket(db, t.id)!.state).toBe("running")

    const th = thread(db, t.id)
    expect(th.comments.some((c) => c.kind === "answer" && c.author === "human" && c.body === "use JWT")).toBe(true)
  })
})

describe("permission", () => {
  test("a decision unblocks the ticket", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api", repo_root: "/srv/slots/1", label: "laptop",
      opencode_version: "1.5.0", capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    const t = createTicket(db, { project_id: "almadel-api", title: "p", column_id: "col-implement" })
    claimNow(db, "almadel-api", agent.agent_id)

    requestPermission(db, t.id, { tool: "bash", command: "git push origin main" })
    expect(getTicket(db, t.id)!.state).toBe("blocked_permission")

    decidePermission(db, t.id, "allow", "once")
    expect(getTicket(db, t.id)!.state).toBe("running")
    expect(thread(db, t.id).comments.some((c) => c.kind === "permission" && c.body?.includes("Allowed"))).toBe(true)
  })
})

describe("lease sweep", () => {
  test("requeues a vanished agent's ticket", () => {
    const db = testDb()
    const agent = registerAgent(db, {
      project: "almadel-api", repo_root: "/srv/slots/1", label: "laptop",
      opencode_version: "1.5.0", capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    const t = createTicket(db, { project_id: "almadel-api", title: "r", column_id: "col-implement" })
    claimNow(db, "almadel-api", agent.agent_id)
    expect(getTicket(db, t.id)!.state).toBe("running")

    // Simulate the agent going silent.
    db.query("UPDATE agents SET last_poll = ? WHERE id = ?").run(Date.now() - 10 * 60_000, agent.agent_id)

    sweep(db, config)
    expect(getTicket(db, t.id)!.state).toBe("ready")
    expect(getTicket(db, t.id)!.agent_id).toBeNull()
  })
})

describe("roster", () => {
  test("presence is derived from last_poll", () => {
    const db = testDb()
    registerAgent(db, {
      project: "almadel-api", repo_root: "/srv/slots/1", label: "laptop",
      opencode_version: "1.5.0", capabilities: { tools: true, permission_hook: true },
    }, { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 })

    const r = roster(db, 90_000)
    const group = r.projects.find((p) => p.project.id === "almadel-api")!
    expect(group.agents).toHaveLength(1)
    expect(group.agents[0]!.online).toBe(true)
  })

  test("needs_you counts blocked tickets", () => {
    const db = testDb()
    createTicket(db, { project_id: "almadel-api", title: "a", column_id: "col-implement" })
    expect(roster(db, 90_000).needs_you).toBe(0)

    const t = createTicket(db, { project_id: "almadel-api", title: "b", column_id: "col-implement" })
    askQuestion(db, t.id, "blocked?")
    expect(roster(db, 90_000).needs_you).toBe(1)
  })
})
