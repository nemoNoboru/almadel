import type { Config } from "../config"
import type { DB } from "../db"
import { newId, now } from "../db"
import { HttpError, zodIssues } from "../http-error"
import { agentJobs, addRosterSub, addTicketSub, projectClaim, removeRosterSub, removeTicketSub } from "../notify"
import type { Agent, Ticket } from "../types"
import {
  askSchema,
  claimBodySchema,
  columnsPutSchema,
  commentSchema,
  commentUpdateSchema,
  createTicketSchema,
  draftSchema,
  eventBatchSchema,
  messageSchema,
  moveTicketSchema,
  permissionDecisionSchema,
  permissionRequestSchema,
  registrationSchema,
  replySchema,
} from "../types"
import { deregisterAgent, getAgent, registerAgent, updateTelemetry } from "../domain/agents"
import {
  askQuestion,
  decidePermission,
  parkPermissionDecision,
  parkQuestionAnswer,
  reply,
  requestPermission,
} from "../domain/blocking"
import { claimNow, makeTaskJob, nextJob } from "../domain/claim"
import { appendEvents, replayEvents } from "../domain/events"
import { roster, thread } from "../domain/roster"
import { listMessages, sendAgentMessage, sendHumanMessage } from "../domain/messages"
import {
  addComment,
  board,
  cancelTicket,
  createTicket,
  getColumn,
  getProject,
  getTicket,
  isPrompted,
  listColumns,
  listProjects,
  moveTicket,
  takeoverTicket,
  updateComment,
} from "../domain/tickets"
import { hasBearer, resolveBearer } from "./auth"
import { createSSE } from "./sse"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function noContent(): Response {
  return new Response(null, { status: 204 })
}

function error(status: number, message: string, issues: Array<{ path: string; message: string }> = []): Response {
  return json({ error: message, issues }, status)
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

// Agent identity for the agent-facing push endpoints: the registration token
// (Bearer) or the agent id the poll loop reuses (§03).
function authenticateAgent(db: DB, request: Request): Agent | null {
  const bearer = resolveBearer(db, request)
  if (bearer) return bearer
  const headerId = request.headers.get("X-Almadel-Agent")
  if (headerId) return getAgent(db, headerId)
  return null
}

function requireHeldTicket(db: DB, agent: Agent, ticketId: string): Ticket {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")
  if (ticket.agent_id !== agent.id) throw new HttpError(403, "not your ticket")
  return ticket
}

async function handleSendMessage(db: DB, request: Request, agentId: string, body: unknown): Promise<Response> {
  if (!getAgent(db, agentId)) return error(404, "agent not found")
  const parsed = messageSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid message", zodIssues(parsed.error))

  const auth = authenticateAgent(db, request)
  if (auth && auth.id !== agentId) return error(403, "not your agent")
  if (auth) sendAgentMessage(db, agentId, parsed.data.body)
  else sendHumanMessage(db, agentId, parsed.data.body)
  return noContent()
}

function draftFromInstruction(instruction: string): { title: string; body: string } {
  const text = instruction.trim()
  const firstLine = text.split(/\r?\n/)[0] ?? text
  const clipped = firstLine.replace(/[.!?]+$/, "").trim()
  const title =
    clipped.length > 80
      ? clipped.slice(0, 80).replace(/\s+\S*$/, "") + "…"
      : clipped || "Untitled card"
  const body = [
    "## Context",
    text,
    "",
    "## Scope",
    "Implement the change described above, on a dedicated branch.",
    "",
    "## Acceptance criteria",
    "- [ ] Tests pass",
    "- [ ] Reviewed in the thread before moving on",
  ].join("\n")
  return { title, body }
}

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

export async function handleApi(
  db: DB,
  config: Config,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  if (!path.startsWith("/api/")) return null

  try {
    // ---- roster ------------------------------------------------------------
    if (method === "GET" && path === "/api/roster") {
      return json(roster(db, config.leaseTtlMs))
    }
    if (method === "GET" && path === "/api/roster/stream") {
      const { stream, response } = createSSE(request)
      addRosterSub(stream)
      request.signal.addEventListener("abort", () => removeRosterSub(stream))
      return response
    }

    // ---- projects ----------------------------------------------------------
    if (method === "GET" && path === "/api/projects") {
      return json(listProjects(db).map((p) => ({ id: p.id, name: p.name })))
    }

    const boardMatch = method === "GET" && /^\/api\/projects\/([^/]+)\/board$/.exec(path)
    if (boardMatch) {
      const b = board(db, boardMatch[1]!)
      if (!b) return error(404, "project not found")
      return json(b)
    }

    const columnsMatch = /^\/api\/projects\/([^/]+)\/columns$/.exec(path)
    if (columnsMatch && method === "GET") {
      if (!getProject(db, columnsMatch[1]!)) return error(404, "project not found")
      return json(listColumns(db, columnsMatch[1]!))
    }
    if (columnsMatch && method === "PUT") {
      return await handlePutColumns(db, columnsMatch[1]!, await readJson(request))
    }

    // ---- agents ------------------------------------------------------------
    if (method === "POST" && path === "/api/agents") {
      return await handleRegister(db, config, await readJson(request))
    }
    const messagesMatch = /^\/api\/agents\/([^/]+)\/messages$/.exec(path)
    if (messagesMatch && method === "GET") {
      return json(listMessages(db, messagesMatch[1]!))
    }
    if (messagesMatch && method === "POST") {
      return await handleSendMessage(db, request, messagesMatch[1]!, await readJson(request))
    }
    const agentMatch = method === "DELETE" && /^\/api\/agents\/([^/]+)$/.exec(path)
    if (agentMatch) {
      deregisterAgent(db, agentMatch[1]!)
      return noContent()
    }

    // ---- claim -------------------------------------------------------------
    if (method === "POST" && path === "/api/claim") {
      return await handleClaim(db, config, request, await readJson(request))
    }

    // ---- tickets (create + draft) -----------------------------------------
    if (method === "POST" && path === "/api/tickets") {
      const parsed = createTicketSchema.safeParse(await readJson(request))
      if (!parsed.success) return error(400, "invalid ticket", zodIssues(parsed.error))
      let creatorAgentId: string | undefined
      if (hasBearer(request)) {
        const agent = resolveBearer(db, request)
        if (!agent) return error(401, "invalid token")
        if (agent.project_id !== parsed.data.project_id) return error(403, "not your project")
        const column = getColumn(db, parsed.data.column_id)
        if (!column || column.project_id !== parsed.data.project_id) return error(400, "column out of scope")
        if (isPrompted(column)) return error(400, "agents can only create tickets on manual columns")
        creatorAgentId = agent.id
      }
      const ticket = createTicket(db, { ...parsed.data, creatorAgentId })
      return json(ticket, 201)
    }
    if (method === "POST" && path === "/api/tickets/draft") {
      return await handleDraft(db, await readJson(request))
    }

    const commentUpdateMatch = method === "PATCH" && /^\/api\/tickets\/([^/]+)\/comments\/([^/]+)$/.exec(path)
    if (commentUpdateMatch) {
      return await handleUpdateComment(db, commentUpdateMatch[1]!, commentUpdateMatch[2]!, await readJson(request))
    }

    // ---- ticket sub-routes -------------------------------------------------
    const ticketIdMatch = /^\/api\/tickets\/([^/]+)(?:\/([^/]+))?$/.exec(path)
    if (ticketIdMatch) {
      const ticketId = ticketIdMatch[1]!
      const sub = ticketIdMatch[2]

      if (method === "GET" && sub === undefined) {
        return handleGetTicket(db, request, ticketId)
      }
      if (method === "GET" && sub === "stream") {
        return handleTicketStream(db, request, ticketId, url)
      }
      if (method === "POST" && sub === "move") {
        return await handleMove(db, request, ticketId, await readJson(request))
      }
      if (method === "POST" && sub === "reply") {
        const parsed = replySchema.safeParse(await readJson(request))
        if (!parsed.success) return error(400, "invalid reply", zodIssues(parsed.error))
        reply(db, ticketId, parsed.data.body)
        return noContent()
      }
      if (method === "POST" && sub === "permission") {
        const parsed = permissionDecisionSchema.safeParse(await readJson(request))
        if (!parsed.success) return error(400, "invalid decision", zodIssues(parsed.error))
        decidePermission(db, ticketId, parsed.data.decision, parsed.data.scope)
        return noContent()
      }
      if (method === "POST" && sub === "permission-request") {
        return await handlePermissionRequest(db, config, request, ticketId, await readJson(request))
      }
      if (method === "POST" && sub === "cancel") {
        cancelTicket(db, ticketId)
        return noContent()
      }
      if (method === "POST" && sub === "takeover") {
        takeoverTicket(db, ticketId)
        return noContent()
      }
      if (method === "POST" && sub === "events") {
        return await handleEvents(db, request, ticketId, await readJson(request))
      }
      if (method === "POST" && sub === "comment") {
        return await handleComment(db, request, ticketId, await readJson(request))
      }
      if (method === "POST" && sub === "ask") {
        return await handleAsk(db, request, ticketId, await readJson(request))
      }
    }

    // ---- questions ---------------------------------------------------------
    const questionMatch = method === "GET" && /^\/api\/questions\/([^/]+)$/.exec(path)
    if (questionMatch) {
      return await handleQuestionPoll(db, config, request, questionMatch[1]!)
    }

    return error(404, "not found")
  } catch (err) {
    if (err instanceof HttpError) return error(err.status, err.message, err.issues)
    console.error("unhandled error:", err)
    return error(500, "internal error")
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleRegister(db: DB, config: Config, body: unknown): Promise<Response> {
  const parsed = registrationSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid registration", zodIssues(parsed.error))
  const result = registerAgent(db, parsed.data, {
    minOpencodeVersion: config.minOpencodeVersion,
    portBase: config.portBase,
    portBandWidth: config.portBandWidth,
  })
  return json(result, 200)
}

async function handleClaim(
  db: DB,
  config: Config,
  request: Request,
  body: unknown,
): Promise<Response> {
  const parsed = claimBodySchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid claim", zodIssues(parsed.error))
  const { project, agent, slot } = parsed.data

  if (!getAgent(db, agent)) return error(404, "unknown agent")
  updateTelemetry(db, agent, slot)

  const deadline = now() + config.pollWindowMs
  for (;;) {
    const job = nextJob(db, agent)
    if (job) return json(job)

    const ticket = claimNow(db, project, agent)
    if (ticket) return json(makeTaskJob(db, ticket, agent))

    const remaining = deadline - now()
    if (remaining <= 0) return noContent()

    await Promise.race([
      agentJobs.wait(agent, remaining),
      projectClaim.wait(project, remaining),
      aborted(request.signal),
    ])
  }
}

async function handleDraft(db: DB, body: unknown): Promise<Response> {
  const parsed = draftSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid draft", zodIssues(parsed.error))
  if (!getProject(db, parsed.data.project_id)) return error(404, "project not found")
  const agent = getAgent(db, parsed.data.agent_id)
  const draft = draftFromInstruction(parsed.data.instruction)
  return json({ ...draft, agent_name: agent?.name ?? "agent" })
}

function handleGetTicket(db: DB, request: Request, ticketId: string): Response {
  if (hasBearer(request)) {
    const agent = resolveBearer(db, request)
    if (!agent) return error(401, "invalid token")
    requireHeldTicket(db, agent, ticketId)
  }
  return json(thread(db, ticketId))
}

function handleTicketStream(db: DB, request: Request, ticketId: string, url: URL): Response {
  if (!getTicket(db, ticketId)) return error(404, "ticket not found")
  const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0

  const { stream, response } = createSSE(request)
  for (const e of replayEvents(db, ticketId, after)) {
    stream.send("tick", JSON.stringify(e))
  }
  addTicketSub(ticketId, stream)
  request.signal.addEventListener("abort", () => removeTicketSub(ticketId, stream))
  return response
}

async function handleMove(db: DB, request: Request, ticketId: string, body: unknown): Promise<Response> {
  const parsed = moveTicketSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid move", zodIssues(parsed.error))

  if (hasBearer(request)) {
    const agent = resolveBearer(db, request)
    if (!agent) return error(401, "invalid token")
    requireHeldTicket(db, agent, ticketId)
  }
  const ticket = moveTicket(db, ticketId, parsed.data.column, parsed.data.note)
  return json(ticket)
}

async function handlePermissionRequest(
  db: DB,
  config: Config,
  request: Request,
  ticketId: string,
  body: unknown,
): Promise<Response> {
  const agent = authenticateAgent(db, request)
  if (!agent) return error(401, "missing agent identity")
  requireHeldTicket(db, agent, ticketId)

  const parsed = permissionRequestSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid request", zodIssues(parsed.error))

  const permissionId = requestPermission(db, ticketId, parsed.data)
  const decision = await parkPermissionDecision(db, permissionId, config.permissionTtlMs)
  if (decision) return json(decision)
  return json({ decision: "deny", scope: "once", timeout: true })
}

async function handleEvents(db: DB, request: Request, ticketId: string, body: unknown): Promise<Response> {
  const agent = authenticateAgent(db, request)
  if (!agent) return error(401, "missing agent identity")
  const ticket = getTicket(db, ticketId)
  if (!ticket) return error(404, "ticket not found")
  if (ticket.agent_id !== agent.id && ticket.agent_id !== null) return error(403, "not your ticket")

  const parsed = eventBatchSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid events", zodIssues(parsed.error))
  return json(appendEvents(db, ticketId, parsed.data.events))
}

async function handleComment(db: DB, request: Request, ticketId: string, body: unknown): Promise<Response> {
  const agent = resolveBearer(db, request)
  if (!agent) return error(401, "invalid token")
  requireHeldTicket(db, agent, ticketId)

  const parsed = commentSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid comment", zodIssues(parsed.error))
  addComment(db, ticketId, "agent", parsed.data.kind, parsed.data.body ?? null)
  return noContent()
}

async function handleUpdateComment(db: DB, ticketId: string, commentIdRaw: string, body: unknown): Promise<Response> {
  const parsed = commentUpdateSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid comment", zodIssues(parsed.error))
  const commentId = Number.parseInt(commentIdRaw, 10)
  if (!Number.isFinite(commentId)) return error(404, "comment not found")
  updateComment(db, ticketId, commentId, parsed.data.body)
  return noContent()
}

async function handleAsk(db: DB, request: Request, ticketId: string, body: unknown): Promise<Response> {
  const agent = resolveBearer(db, request)
  if (!agent) return error(401, "invalid token")
  requireHeldTicket(db, agent, ticketId)

  const parsed = askSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid question", zodIssues(parsed.error))
  const id = askQuestion(db, ticketId, parsed.data.question)
  return json({ id })
}

async function handleQuestionPoll(
  db: DB,
  config: Config,
  request: Request,
  questionId: string,
): Promise<Response> {
  const agent = resolveBearer(db, request)
  if (!agent) return error(401, "invalid token")

  const question = db.query("SELECT * FROM questions WHERE id = ?").get(questionId) as
    | { ticket_id: string; answer: string | null }
    | undefined
  if (!question) return error(404, "question not found")
  if (question.ticket_id !== agent.ticket_id) return error(403, "not your question")

  const answer = await parkQuestionAnswer(db, questionId, config.askTimeoutMs)
  if (answer === null) return noContent()
  return json({ answer })
}

async function handlePutColumns(db: DB, projectId: string, body: unknown): Promise<Response> {
  const parsed = columnsPutSchema.safeParse(body)
  if (!parsed.success) return error(400, "invalid columns", zodIssues(parsed.error))
  if (!getProject(db, projectId)) return error(404, "project not found")

  const columns = parsed.data.columns
  db.transaction(() => {
    db.query("DELETE FROM columns WHERE project_id = ?").run(projectId)
    const insert = db.query(
      "INSERT INTO columns (id, project_id, name, position, prompt, next_column, fail_column, wip_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    columns.forEach((c, i) => {
      insert.run(c.id ?? newId("col"), projectId, c.name, i, c.prompt, c.next_column, c.fail_column, c.wip_limit)
    })
  })()

  return json(listColumns(db, projectId))
}
