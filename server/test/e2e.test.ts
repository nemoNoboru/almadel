import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Config } from "../src/config"
import { openDb, seed } from "../src/db"
import { startServer } from "../src/index"
import { AlmadelClient } from "../../plugin/src/http.ts"
import { askQuestion } from "../../plugin/src/ask.ts"
import { createState } from "../../plugin/src/state.ts"

const PORT = 18821
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = "almadel-api"

const config: Config = {
  host: "127.0.0.1",
  port: PORT,
  dbPath: ":memory:",
  staticDir: null,
  pollWindowMs: 500,
  leaseTtlMs: 90_000,
  sweepIntervalMs: 60_000,
  askTimeoutMs: 2_000,
  permissionTtlMs: 2_000,
  portBase: 8000,
  portBandWidth: 100,
  minOpencodeVersion: "1.0.0",
}

let db: ReturnType<typeof openDb>
let server: ReturnType<typeof startServer>
let agent: AlmadelClient
let agentId: string

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(25)
  }
  return false
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = undefined
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
  }
  return { status: res.status, json }
}

async function getThread(ticketId: string) {
  return (await call("GET", `/api/tickets/${ticketId}`)).json
}

async function claimTask() {
  const job = await agent.claim({ project: PROJECT, agent: agentId })
  if (!job || job.type !== "task") throw new Error("expected a task job")
  return job
}

describe("end-to-end: hello endpoint feature", () => {
  beforeAll(() => {
    db = openDb(":memory:")
    seed(db)
    server = startServer(db, config)
    agent = new AlmadelClient(BASE)
  })

  afterAll(() => {
    server.stop()
    db.close()
  })

  test("flows from Spec through Planning, Implement and Testing to Done", async () => {
    const roster0 = await call("GET", "/api/roster")
    expect(roster0.status).toBe(200)
    expect(roster0.json.needs_you).toBe(0)
    expect(roster0.json.projects[0].agents).toEqual([])

    const projects = await call("GET", "/api/projects")
    expect(projects.json).toEqual([{ id: PROJECT, name: PROJECT }])

    const created = await call("POST", "/api/tickets", {
      project_id: PROJECT,
      title: "Add a hello endpoint",
      body: "GET /hello returns a friendly JSON greeting.",
      column_id: "col-spec",
    })
    expect(created.status).toBe(201)
    const ticketId: string = created.json.id
    expect(ticketId).toMatch(/^TCK-/)
    expect(created.json.state).toBe("ready")

    const reg = await agent.register({
      project: PROJECT,
      repo_root: "/srv/slots/1",
      label: "laptop",
      opencode_version: "1.0.0",
      capabilities: { tools: true, permission_hook: true },
    })
    expect(reg.agent_id).toMatch(/^agt_/)
    expect(reg.token).toBeTruthy()
    agent.setAuth(reg.token, reg.agent_id)
    agentId = reg.agent_id

    const noJob = await agent.claim({ project: PROJECT, agent: agentId })
    expect(noJob).toBeUndefined()

    const moved = await call("POST", `/api/tickets/${ticketId}/move`, { column: "col-planning" })
    expect(moved.status).toBe(200)
    expect(moved.json.state).toBe("ready")

    const planJob = await claimTask()
    expect(planJob.prompt).toContain("implementation plan")
    expect(planJob.branch).toBe(`run/${ticketId}`)
    expect(planJob.project).toBe(PROJECT)

    await agent.comment(ticketId, { kind: "plan", body: "Add a /hello route that returns JSON." })

    const answerPromise = askQuestion(agent, createState(), ticketId, "Which HTTP framework should I use?")
    const blockedQuestion = await waitFor(async () => (await getThread(ticketId)).ticket.state === "blocked_question")
    expect(blockedQuestion).toBe(true)
    await sleep(250)
    const replyRes = await call("POST", `/api/tickets/${ticketId}/reply`, { body: "Bun.serve" })
    expect(replyRes.status).toBe(204)
    expect(await answerPromise).toBe("Bun.serve")

    await agent.move(ticketId, { column: "col-review" })
    const afterReview = await getThread(ticketId)
    expect(afterReview.ticket.column_id).toBe("col-review")
    expect(afterReview.ticket.agent_id).toBeNull()

    await call("POST", `/api/tickets/${ticketId}/move`, { column: "col-implement" })

    const implJob = await claimTask()
    expect(implJob.prompt).toContain("Implement it on branch")

    const permPromise = agent.requestPermission(ticketId, { command: "bun test" })
    const blockedPermission = await waitFor(async () => (await getThread(ticketId)).ticket.state === "blocked_permission")
    expect(blockedPermission).toBe(true)
    await sleep(250)
    const decision = await call("POST", `/api/tickets/${ticketId}/permission`, { decision: "allow", scope: "once" })
    expect(decision.status).toBe(204)
    expect(await permPromise).toEqual({ decision: "allow", scope: "once" })

    const events = (await agent.pushEvents(ticketId, {
      events: [{ kind: "log", payload: { msg: "hello tests ran" } }],
    })) as any[]
    expect(events).toHaveLength(1)
    expect(events[0].seq).toBe(1)
    expect(events[0].kind).toBe("log")

    await agent.move(ticketId, { column: "col-testing" })

    const testJob = await claimTask()
    expect(testJob.prompt).toContain("Verify the change")

    await agent.move(ticketId, { column: "col-done" })

    const thread = await getThread(ticketId)
    expect(thread.ticket.state).toBe("done")
    expect(thread.ticket.column_id).toBe("col-done")
    const kinds = thread.comments.map((c: any) => c.kind)
    expect(kinds).toContain("plan")
    expect(kinds).toContain("question")
    expect(kinds).toContain("answer")
    expect(kinds).toContain("permission")
    expect(kinds).toContain("move")

    const board = (await call("GET", `/api/projects/${PROJECT}/board`)).json
    const doneTicket = board.tickets.find((t: any) => t.id === ticketId)
    expect(doneTicket.column_id).toBe("col-done")

    const roster = (await call("GET", "/api/roster")).json
    expect(roster.needs_you).toBe(0)
    const agentRow = roster.projects
      .find((p: any) => p.project.id === PROJECT)
      .agents.find((a: any) => a.id === agentId)
    expect(agentRow.online).toBe(true)
    expect(agentRow.status).toBe("idle")
  })
})
