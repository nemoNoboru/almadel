import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { Config } from "../src/config"
import { migrate, seed } from "../src/db"
import { registerAgent } from "../src/domain/agents"
import { requestPermission } from "../src/domain/blocking"
import { claimNow } from "../src/domain/claim"
import { createTicket, getTicket } from "../src/domain/tickets"
import { handleApi } from "../src/server/router"

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

// Config with near-zero timeouts so blocking endpoints resolve immediately.
const fastConfig: Config = {
  ...config,
  pollWindowMs: 1,
  askTimeoutMs: 1,
  permissionTtlMs: 1,
}

type ApiOpts = { token?: string; agentId?: string; body?: unknown }

function api(
  db: Database,
  cfg: Config,
  method: string,
  path: string,
  opts: ApiOpts = {},
): Promise<Response | null> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.agentId) headers["X-Almadel-Agent"] = opts.agentId
  const init: RequestInit = { method, headers }
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(opts.body)
  }
  return handleApi(db, cfg, new Request(`http://localhost${path}`, init))
}

function register(db: Database, repoRoot = "/srv/slots/1", label = "laptop") {
  return registerAgent(
    db,
    {
      project: "almadel-api",
      repo_root: repoRoot,
      label,
      opencode_version: "1.5.0",
      capabilities: { tools: true, permission_hook: true },
    },
    { minOpencodeVersion: "1.0.0", portBase: 8000, portBandWidth: 100 },
  )
}

function holdTicket(db: Database, agentId: string) {
  const ticket = createTicket(db, { project_id: "almadel-api", title: "t", column_id: "col-implement" })
  claimNow(db, "almadel-api", agentId)
  return ticket
}

describe("routing", () => {
  test("returns null for non-/api paths (static serving territory)", async () => {
    const res = await api(testDb(), config, "GET", "/p/almadel-api")
    expect(res).toBeNull()
  })

  test("404 for unknown /api paths", async () => {
    const res = await api(testDb(), config, "GET", "/api/nope")
    expect(res!.status).toBe(404)
    expect(await res!.json()).toEqual({ error: "not found", issues: [] })
  })
})

describe("roster + projects", () => {
  test("GET /api/roster returns projects and needs_you", async () => {
    const db = testDb()
    const res = await api(db, config, "GET", "/api/roster")
    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.needs_you).toBe(0)
    expect(body.projects[0].project.id).toBe("almadel-api")
  })

  test("GET /api/projects lists {id,name}", async () => {
    const res = await api(testDb(), config, "GET", "/api/projects")
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual([{ id: "almadel-api", name: "almadel-api" }])
  })

  test("GET /api/projects/{id}/board 404s for unknown project", async () => {
    const res = await api(testDb(), config, "GET", "/api/projects/nope/board")
    expect(res!.status).toBe(404)
    expect(await res!.json()).toEqual({ error: "project not found", issues: [] })
  })

  test("GET /api/projects/{id}/board returns the seeded board", async () => {
    const res = await api(testDb(), config, "GET", "/api/projects/almadel-api/board")
    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.columns.map((c: { name: string }) => c.name)).toEqual([
      "Spec", "Planning", "Review", "Implement", "Testing", "Done", "Failed",
    ])
  })

  test("GET/PUT columns replace the board", async () => {
    const db = testDb()
    const got = await api(db, config, "GET", "/api/projects/almadel-api/columns")
    expect(got!.status).toBe(200)
    expect((await got!.json()) as unknown[]).toHaveLength(7)

    const put = await api(db, config, "PUT", "/api/projects/almadel-api/columns", {
      body: { columns: [{ name: "Backlog", prompt: null, next_column: null, fail_column: null, wip_limit: null }] },
    })
    expect(put!.status).toBe(200)
    const body = (await put!.json()) as Array<{ name: string }>
    expect(body.map((c) => c.name)).toEqual(["Backlog"])
  })

  test("PUT columns rejects invalid body with issues", async () => {
    const res = await api(testDb(), config, "PUT", "/api/projects/almadel-api/columns", {
      body: { columns: [{ name: "no prompt field" }] },
    })
    expect(res!.status).toBe(400)
    const body = await res!.json()
    expect(body.error).toBe("invalid columns")
    expect(body.issues.length).toBeGreaterThan(0)
  })
})

describe("registration", () => {
  test("POST /api/agents registers and returns a token", async () => {
    const res = await api(testDb(), config, "POST", "/api/agents", {
      body: {
        project: "almadel-api",
        repo_root: "/srv/slots/1",
        label: "laptop",
        opencode_version: "1.5.0",
        capabilities: { tools: true, permission_hook: true },
      },
    })
    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.agent_id).toMatch(/^agt_/)
    expect(body.token).toBeTruthy()
    expect(typeof body.port_base).toBe("number")
  })

  test("POST /api/agents 400s with issues on missing fields", async () => {
    const res = await api(testDb(), config, "POST", "/api/agents", { body: {} })
    expect(res!.status).toBe(400)
    const body = await res!.json()
    expect(body.error).toBe("invalid registration")
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(["project", "repo_root"])
  })

  test("POST /api/agents 409s on an outdated opencode version", async () => {
    const res = await api(testDb(), config, "POST", "/api/agents", {
      body: {
        project: "almadel-api",
        repo_root: "/srv/slots/1",
        opencode_version: "0.9.4",
        capabilities: { tools: true },
      },
    })
    expect(res!.status).toBe(409)
  })

  test("DELETE /api/agents/{id} returns 204; unknown id 404s", async () => {
    const db = testDb()
    const agent = register(db)
    const del = await api(db, config, "DELETE", `/api/agents/${agent.agent_id}`)
    expect(del!.status).toBe(204)

    const again = await api(db, config, "DELETE", `/api/agents/${agent.agent_id}`)
    expect(again!.status).toBe(404)
  })
})

describe("tickets", () => {
  test("POST /api/tickets creates and returns 201", async () => {
    const res = await api(testDb(), config, "POST", "/api/tickets", {
      body: { project_id: "almadel-api", title: "hi", column_id: "col-implement" },
    })
    expect(res!.status).toBe(201)
    const body = await res!.json()
    expect(body.id).toMatch(/^TCK-/)
    expect(body.state).toBe("ready")
  })

  test("POST /api/tickets 400s on invalid body", async () => {
    const res = await api(testDb(), config, "POST", "/api/tickets", { body: { project_id: "almadel-api" } })
    expect(res!.status).toBe(400)
    expect((await res!.json()).error).toBe("invalid ticket")
  })

  test("GET /api/tickets/{id} returns the thread (no auth)", async () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "hi", column_id: "col-implement" })
    const res = await api(db, config, "GET", `/api/tickets/${t.id}`)
    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.ticket.id).toBe(t.id)
    expect(Array.isArray(body.comments)).toBe(true)
  })

  test("GET /api/tickets/{id} 404s for unknown ticket", async () => {
    const res = await api(testDb(), config, "GET", "/api/tickets/nope")
    expect(res!.status).toBe(404)
  })

  test("move, reply, cancel, takeover round-trip", async () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-implement" })

    const moved = await api(db, config, "POST", `/api/tickets/${t.id}/move`, { body: { column: "col-done" } })
    expect(moved!.status).toBe(200)
    expect((await moved!.json()).state).toBe("done")

    const replied = await api(db, config, "POST", `/api/tickets/${t.id}/reply`, { body: { body: "ok" } })
    expect(replied!.status).toBe(204)

    const takeover = await api(db, config, "POST", `/api/tickets/${t.id}/takeover`)
    expect(takeover!.status).toBe(204)

    const cancel = await api(db, config, "POST", `/api/tickets/${t.id}/cancel`)
    expect(cancel!.status).toBe(204)
  })

  test("move 400s on invalid body and 409s at the WIP limit", async () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-spec" })

    const bad = await api(db, config, "POST", `/api/tickets/${t.id}/move`, { body: {} })
    expect(bad!.status).toBe(400)

    const t1 = createTicket(db, { project_id: "almadel-api", title: "a", column_id: "col-implement" })
    const t2 = createTicket(db, { project_id: "almadel-api", title: "b", column_id: "col-implement" })
    db.query("UPDATE tickets SET state = 'running' WHERE id IN (?, ?)").run(t1.id, t2.id)

    const wip = await api(db, config, "POST", `/api/tickets/${t.id}/move`, { body: { column: "col-implement" } })
    expect(wip!.status).toBe(409)
  })

  test("draft mirrors the instruction into title/body", async () => {
    const res = await api(testDb(), config, "POST", "/api/tickets/draft", {
      body: { project_id: "almadel-api", agent_id: "nope", instruction: "Fix the login bug" },
    })
    expect(res!.status).toBe(200)
    const body = await res!.json()
    expect(body.title).toBe("Fix the login bug")
    expect(body.body).toContain("Fix the login bug")
    expect(body.agent_name).toBe("agent")
  })

  test("draft 404s for unknown project", async () => {
    const res = await api(testDb(), config, "POST", "/api/tickets/draft", {
      body: { project_id: "nope", agent_id: "nope", instruction: "x" },
    })
    expect(res!.status).toBe(404)
  })
})

describe("agent auth", () => {
  test("GET thread with a foreign bearer 403s", async () => {
    const db = testDb()
    const holder = register(db, "/srv/slots/1")
    const other = register(db, "/srv/slots/2")
    const t = holdTicket(db, holder.agent_id)

    const res = await api(db, config, "GET", `/api/tickets/${t.id}`, { token: other.token })
    expect(res!.status).toBe(403)
    expect((await res!.json()).error).toBe("not your ticket")
  })

  test("comment/ask/events require a valid token", async () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-implement" })

    const comment = await api(db, config, "POST", `/api/tickets/${t.id}/comment`, {
      body: { kind: "comment", body: "hi" },
    })
    expect(comment!.status).toBe(401)

    const ask = await api(db, config, "POST", `/api/tickets/${t.id}/ask`, { body: { question: "q?" } })
    expect(ask!.status).toBe(401)

    const events = await api(db, config, "POST", `/api/tickets/${t.id}/events`, {
      body: { events: [{ kind: "x" }] },
    })
    expect(events!.status).toBe(401)
  })

  test("events append and return seq-assigned rows for the holder", async () => {
    const db = testDb()
    const holder = register(db)
    const t = holdTicket(db, holder.agent_id)

    const res = await api(db, config, "POST", `/api/tickets/${t.id}/events`, {
      token: holder.token,
      body: { events: [{ kind: "tool_use", payload: { name: "bash" } }, { kind: "tool_result" }] },
    })
    expect(res!.status).toBe(200)
    const rows = await res!.json()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ seq: 1, kind: "tool_use" })
    expect(rows[0].payload).toBe(JSON.stringify({ name: "bash" }))
    expect(rows[1]).toMatchObject({ seq: 2, kind: "tool_result" })
  })

  test("events 403 for an agent that does not hold the ticket", async () => {
    const db = testDb()
    const holder = register(db, "/srv/slots/1")
    const other = register(db, "/srv/slots/2")
    const t = holdTicket(db, holder.agent_id)

    const res = await api(db, config, "POST", `/api/tickets/${t.id}/events`, {
      token: other.token,
      body: { events: [{ kind: "x" }] },
    })
    expect(res!.status).toBe(403)
  })
})

describe("claim", () => {
  test("unknown agent 404s", async () => {
    const res = await api(testDb(), fastConfig, "POST", "/api/claim", {
      body: { project: "almadel-api", agent: "nope" },
    })
    expect(res!.status).toBe(404)
  })

  test("returns a task job when a ready ticket exists", async () => {
    const db = testDb()
    const agent = register(db)
    const t = createTicket(db, { project_id: "almadel-api", title: "Add rate limiting", column_id: "col-planning" })

    const res = await api(db, fastConfig, "POST", "/api/claim", {
      body: { project: "almadel-api", agent: agent.agent_id },
    })
    expect(res!.status).toBe(200)
    const job = await res!.json()
    expect(job.type).toBe("task")
    expect(job.ticket).toBe(t.id)
    expect(job.branch).toBe(`run/${t.id}`)
  })

  test("204 when nothing is claimable within the poll window", async () => {
    const db = testDb()
    const agent = register(db)
    const res = await api(db, fastConfig, "POST", "/api/claim", {
      body: { project: "almadel-api", agent: agent.agent_id },
    })
    expect(res!.status).toBe(204)
  })
})

describe("blocking (question + permission)", () => {
  test("ask returns an id; question poll times out to 204 for the holder", async () => {
    const db = testDb()
    const agent = register(db)
    const t = holdTicket(db, agent.agent_id)

    const ask = await api(db, fastConfig, "POST", `/api/tickets/${t.id}/ask`, {
      token: agent.token,
      body: { question: "which backend?" },
    })
    expect(ask!.status).toBe(200)
    const { id } = await ask!.json()
    expect(id).toMatch(/^q_/)

    const poll = await api(db, fastConfig, "GET", `/api/questions/${id}`, { token: agent.token })
    expect(poll!.status).toBe(204)
  })

  test("question poll 403s when the agent holds a different ticket", async () => {
    const db = testDb()
    const agent = register(db, "/srv/slots/1")
    const other = register(db, "/srv/slots/2")
    const t = holdTicket(db, agent.agent_id)

    const ask = await api(db, fastConfig, "POST", `/api/tickets/${t.id}/ask`, {
      token: agent.token,
      body: { question: "q?" },
    })
    const { id } = await ask!.json()

    const poll = await api(db, fastConfig, "GET", `/api/questions/${id}`, { token: other.token })
    expect(poll!.status).toBe(403)
  })

  test("permission decision resolves a pending permission", async () => {
    const db = testDb()
    const agent = register(db)
    const t = holdTicket(db, agent.agent_id)
    requestPermission(db, t.id, { command: "git push origin main" })
    expect(getTicket(db, t.id)!.state).toBe("blocked_permission")

    const res = await api(db, config, "POST", `/api/tickets/${t.id}/permission`, {
      body: { decision: "allow", scope: "once" },
    })
    expect(res!.status).toBe(204)
    expect(getTicket(db, t.id)!.state).toBe("running")
  })

  test("permission decision 404s with nothing pending", async () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-implement" })
    const res = await api(db, config, "POST", `/api/tickets/${t.id}/permission`, {
      body: { decision: "allow", scope: "once" },
    })
    expect(res!.status).toBe(404)
  })

  test("permission-request requires agent identity and ticket ownership", async () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-implement" })

    const noAuth = await api(db, fastConfig, "POST", `/api/tickets/${t.id}/permission-request`, {
      body: { command: "git push" },
    })
    expect(noAuth!.status).toBe(401)

    const agent = register(db, "/srv/slots/1")
    const notHeld = await api(db, fastConfig, "POST", `/api/tickets/${t.id}/permission-request`, {
      token: agent.token,
      body: { command: "git push" },
    })
    expect(notHeld!.status).toBe(403)
  })

  test("permission-request times out to a deny once", async () => {
    const db = testDb()
    const agent = register(db)
    const t = holdTicket(db, agent.agent_id)

    const res = await api(db, fastConfig, "POST", `/api/tickets/${t.id}/permission-request`, {
      token: agent.token,
      body: { command: "git push" },
    })
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ decision: "deny", scope: "once", timeout: true })
  })
})

describe("streams", () => {
  test("roster stream returns event-stream", async () => {
    const res = await api(testDb(), config, "GET", "/api/roster/stream")
    expect(res!.status).toBe(200)
    expect(res!.headers.get("content-type")).toContain("text/event-stream")
  })

  test("ticket stream 404s for unknown ticket", async () => {
    const res = await api(testDb(), config, "GET", "/api/tickets/nope/stream")
    expect(res!.status).toBe(404)
  })

  test("ticket stream returns event-stream for a known ticket", async () => {
    const db = testDb()
    const t = createTicket(db, { project_id: "almadel-api", title: "x", column_id: "col-implement" })
    const res = await api(db, config, "GET", `/api/tickets/${t.id}/stream`)
    expect(res!.status).toBe(200)
    expect(res!.headers.get("content-type")).toContain("text/event-stream")
  })
})
