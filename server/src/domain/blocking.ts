import { broadcastRoster, permissionDecision, questionAnswer } from "../notify"
import { newId, now } from "../db"
import type { DB } from "../db"
import { HttpError } from "../http-error"
import type { Permission, PermissionScope, Question } from "../types"
import { addComment, getTicket, queueJob } from "./tickets"

// ---------------------------------------------------------------------------
// Questions (the ask loop, server side — plan/06)
// ---------------------------------------------------------------------------

function mapQuestion(row: Record<string, unknown>): Question {
  return {
    id: row.id as string,
    ticket_id: row.ticket_id as string,
    body: row.body as string,
    answer: (row.answer as string | null) ?? null,
    deferred: (row.deferred as number) === 1,
    created_at: (row.created_at as number) ?? 0,
    answered_at: (row.answered_at as number | null) ?? null,
  }
}

export function getOpenQuestion(db: DB, ticketId: string): Question | null {
  const row = db
    .query("SELECT * FROM questions WHERE ticket_id = ? AND answer IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(ticketId) as Record<string, unknown> | undefined
  return row ? mapQuestion(row) : null
}

export function getQuestion(db: DB, id: string): Question | null {
  const row = db.query("SELECT * FROM questions WHERE id = ?").get(id) as Record<string, unknown> | undefined
  return row ? mapQuestion(row) : null
}

// almadel_ask fires → create the question, block the ticket, and let the badge
// flip immediately (push, not poll).
export function askQuestion(db: DB, ticketId: string, body: string): string {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  const id = newId("q")
  const ts = now()

  db.query("UPDATE tickets SET state = 'blocked_question' WHERE id = ?").run(ticketId)
  db.query("UPDATE agents SET status = 'blocked_question', since = ? WHERE id = ?").run(ts, ticket.agent_id)
  db.query(
    "INSERT INTO questions (id, ticket_id, body, answer, deferred, created_at, answered_at) VALUES (?, ?, ?, NULL, 0, ?, NULL)",
  ).run(id, ticketId, body, ts)
  addComment(db, ticketId, "agent", "question", body)

  broadcastRoster()
  return id
}

// The plugin blocks here for the answer (fast path). Returns the answer text or
// null on timeout; on timeout the question is marked deferred server-side.
export async function parkQuestionAnswer(
  db: DB,
  questionId: string,
  timeoutMs: number,
): Promise<string | null> {
  const answer = await questionAnswer.wait(questionId, timeoutMs)
  if (answer === null) {
    db.query("UPDATE questions SET deferred = 1 WHERE id = ? AND answer IS NULL").run(questionId)
  }
  return answer
}

// ---------------------------------------------------------------------------
// Permissions (plan/06)
// ---------------------------------------------------------------------------

function mapPermission(row: Record<string, unknown>): Permission {
  return {
    id: row.id as string,
    ticket_id: row.ticket_id as string,
    tool: (row.tool as string | null) ?? null,
    command: (row.command as string | null) ?? null,
    decision: (row.decision as Permission["decision"]) ?? null,
    scope: (row.scope as Permission["scope"]) ?? null,
    created_at: (row.created_at as number) ?? 0,
    decided_at: (row.decided_at as number | null) ?? null,
  }
}

export function getOpenPermission(db: DB, ticketId: string): Permission | null {
  const row = db
    .query("SELECT * FROM permissions WHERE ticket_id = ? AND decision IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(ticketId) as Record<string, unknown> | undefined
  return row ? mapPermission(row) : null
}

export function getPermission(db: DB, id: string): Permission | null {
  const row = db.query("SELECT * FROM permissions WHERE id = ?").get(id) as Record<string, unknown> | undefined
  return row ? mapPermission(row) : null
}

// The permission hook fires (agent did NOT cooperate). Record it and block the
// ticket; the plugin then long-polls for the decision.
export function requestPermission(
  db: DB,
  ticketId: string,
  input: { tool?: string; command?: string },
): string {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  const id = newId("prm")
  const ts = now()

  db.query("UPDATE tickets SET state = 'blocked_permission' WHERE id = ?").run(ticketId)
  db.query("UPDATE agents SET status = 'blocked_permission', since = ? WHERE id = ?").run(ts, ticket.agent_id)
  db.query(
    "INSERT INTO permissions (id, ticket_id, tool, command, decision, scope, created_at, decided_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)",
  ).run(id, ticketId, input.tool ?? null, input.command ?? null, ts)
  addComment(db, ticketId, "agent", "permission", input.command ?? input.tool ?? "")

  broadcastRoster()
  return id
}

// The plugin blocks here for the decision (fast path, in-process). Returns the
// decision or null on timeout.
export async function parkPermissionDecision(
  db: DB,
  permissionId: string,
  timeoutMs: number,
): Promise<{ decision: "allow" | "deny"; scope: string } | null> {
  return permissionDecision.wait(permissionId, timeoutMs)
}

// Human decides (browser). Records the decision; resolves a parked poll (fast)
// or queues a permission job for the agent's next claim (slow).
export function decidePermission(
  db: DB,
  ticketId: string,
  decision: "allow" | "deny",
  scope: PermissionScope,
): Permission {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  const permission = getOpenPermission(db, ticketId)
  if (!permission) throw new HttpError(404, "no pending permission")

  const ts = now()
  db.query("UPDATE permissions SET decision = ?, scope = ?, decided_at = ? WHERE id = ?").run(
    decision,
    scope,
    ts,
    permission.id,
  )
  db.query("UPDATE tickets SET state = 'running' WHERE id = ?").run(ticketId)
  if (ticket.agent_id) db.query("UPDATE agents SET status = 'working' WHERE id = ?").run(ticket.agent_id)

  addComment(
    db,
    ticketId,
    "human",
    "permission",
    `${decision === "allow" ? "Allowed" : "Denied"} ${permission.command ?? ""} (${scope})`,
  )

  const delivered = permissionDecision.broadcast(permission.id, { decision, scope })
  if (!delivered && ticket.agent_id) {
    queueJob(db, ticket.agent_id, "permission", ticketId, JSON.stringify({ permission_id: permission.id, decision, scope }))
  }

  broadcastRoster()
  return getPermission(db, permission.id)!
}

// ---------------------------------------------------------------------------
// Reply (browser) — fast/slow branching per §12.6
// ---------------------------------------------------------------------------

export function reply(db: DB, ticketId: string, body: string): void {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  const question = getOpenQuestion(db, ticketId)

  if (ticket.state === "blocked_question" && question) {
    const ts = now()
    db.query("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?").run(body, ts, question.id)
    db.query("UPDATE tickets SET state = 'running' WHERE id = ?").run(ticketId)
    if (ticket.agent_id) db.query("UPDATE agents SET status = 'working' WHERE id = ?").run(ticket.agent_id)
    addComment(db, ticketId, "human", "answer", body)

    const delivered = questionAnswer.broadcast(question.id, body)
    if (!delivered) {
      db.query("UPDATE questions SET deferred = 1 WHERE id = ?").run(question.id)
      if (ticket.agent_id) queueJob(db, ticket.agent_id, "reply", ticketId, body)
    }
  } else if (ticket.state === "running") {
    // Nudge: the session is mid-turn and can't accept a message, so queue it.
    db.query("INSERT INTO pending_messages (ticket_id, body, created_at, sent_at) VALUES (?, ?, ?, NULL)").run(
      ticketId,
      body,
      now(),
    )
    addComment(db, ticketId, "human", "answer", body)
    if (ticket.agent_id) queueJob(db, ticket.agent_id, "reply", ticketId, body)
  } else {
    addComment(db, ticketId, "human", "answer", body)
  }

  broadcastRoster()
}
