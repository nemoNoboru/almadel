import { agentJobs, broadcastRoster, broadcastTicket, projectClaim } from "../notify"
import { mapColumn, mapComment, mapProject, nextTicketId, now } from "../db"
import type { DB } from "../db"
import { HttpError } from "../http-error"
import type { Board, Column, Comment, CommentAuthor, CommentKind, Ticket, TicketState } from "../types"

// ---------------------------------------------------------------------------
// Column classification
// ---------------------------------------------------------------------------

export function isPrompted(column: Column): boolean {
  return column.prompt != null
}

// The state a ticket lands in when it arrives in a column:
//   prompted                    -> ready (claimable)
//   human gate (next_column)    -> ready (awaiting a human drag)
//   terminal "fail"             -> failed
//   terminal (done)             -> done
export function targetStateFor(column: Column): TicketState {
  if (column.prompt != null) return "ready"
  if (column.next_column != null) return "ready"
  return /fail/i.test(column.name) ? "failed" : "done"
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getProject(db: DB, id: string) {
  return mapProject(db.query("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined)
}

export function listProjects(db: DB) {
  return (
    db.query("SELECT * FROM projects ORDER BY name ASC").all() as Record<string, unknown>[]
  ).map((r) => mapProject(r)!)
}

export function getColumn(db: DB, id: string): Column | null {
  return mapColumn(db.query("SELECT * FROM columns WHERE id = ?").get(id) as Record<string, unknown> | undefined)
}

export function listColumns(db: DB, projectId: string): Column[] {
  return (
    db
      .query("SELECT * FROM columns WHERE project_id = ? ORDER BY position ASC")
      .all(projectId) as Record<string, unknown>[]
  ).map((r) => mapColumn(r)!)
}

export function getTicket(db: DB, id: string): Ticket | null {
  const row = db.query("SELECT * FROM tickets WHERE id = ?").get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return mapTicket(row)
}

export function listTickets(db: DB, projectId: string): Ticket[] {
  const rows = db
    .query("SELECT * FROM tickets WHERE project_id = ? ORDER BY priority DESC, created_at ASC")
    .all(projectId) as Record<string, unknown>[]
  return rows.map(mapTicket)
}

export function mapTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    title: row.title as string,
    body: (row.body as string | null) ?? null,
    column_id: row.column_id as string,
    state: row.state as TicketState,
    branch: (row.branch as string | null) ?? null,
    head_sha: (row.head_sha as string | null) ?? null,
    agent_id: (row.agent_id as string | null) ?? null,
    priority: (row.priority as number) ?? 0,
    claimed_at: (row.claimed_at as number | null) ?? null,
    created_at: (row.created_at as number) ?? 0,
  }
}

export function listComments(db: DB, ticketId: string): Comment[] {
  const rows = db
    .query("SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC, id ASC")
    .all(ticketId) as Record<string, unknown>[]
  return rows.map((r) => mapComment(r)!)
}

export function board(db: DB, projectId: string): Board | null {
  const project = getProject(db, projectId)
  if (!project) return null
  return {
    project,
    columns: listColumns(db, projectId),
    tickets: listTickets(db, projectId),
  }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export function addComment(
  db: DB,
  ticketId: string,
  author: CommentAuthor,
  kind: CommentKind,
  body: string | null,
): number {
  const res = db
    .query("INSERT INTO comments (ticket_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(ticketId, author, kind, body, now())
  return Number(res.lastInsertRowid)
}

export function updateComment(db: DB, ticketId: string, commentId: number, body: string): Comment {
  const row = db.query("SELECT * FROM comments WHERE id = ?").get(commentId) as Record<string, unknown> | undefined
  if (!row || row.ticket_id !== ticketId) throw new HttpError(404, "comment not found")
  if (row.author === "system") throw new HttpError(403, "system comments are not editable")

  db.query("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?").run(body, now(), commentId)
  broadcastTicket(ticketId, "{}")
  return mapComment(db.query("SELECT * FROM comments WHERE id = ?").get(commentId) as Record<string, unknown> | undefined)!
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function createTicket(
  db: DB,
  input: { project_id: string; title: string; body?: string; column_id: string },
): Ticket {
  const project = getProject(db, input.project_id)
  if (!project) throw new HttpError(404, "project not found")

  const column = getColumn(db, input.column_id)
  if (!column || column.project_id !== input.project_id) throw new HttpError(400, "column out of scope")

  const id = nextTicketId(db)
  const state = targetStateFor(column)
  const ts = now()

  db.query(
    "INSERT INTO tickets (id, project_id, title, body, column_id, state, branch, agent_id, priority, claimed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?)",
  ).run(id, input.project_id, input.title, input.body ?? null, input.column_id, state, ts)

  const ticket = getTicket(db, id)!

  if (column.prompt != null) projectClaim.broadcast(project.id, undefined)
  broadcastRoster()
  return ticket
}

export function moveTicket(
  db: DB,
  ticketId: string,
  columnId: string,
  note?: string,
  headSha?: string | null,
): Ticket {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  const column = getColumn(db, columnId)
  if (!column || column.project_id !== ticket.project_id) throw new HttpError(400, "column out of scope")

  if (column.wip_limit != null && ticket.column_id !== columnId) {
    const inProgress = (
      db
        .query(
          "SELECT count(*) AS n FROM tickets WHERE column_id = ? AND (state = 'running' OR state LIKE 'blocked%')",
        )
        .get(columnId) as { n: number }
    ).n
    if (inProgress >= column.wip_limit) {
      throw new HttpError(409, `wip_limit reached for ${column.name}`)
    }
  }

  const state = targetStateFor(column)

  db.query(
    "UPDATE tickets SET column_id = ?, state = ?, head_sha = COALESCE(?, head_sha), agent_id = NULL, claimed_at = NULL WHERE id = ?",
  ).run(columnId, state, headSha ?? null, ticketId)

  if (ticket.agent_id) releaseAgent(db, ticket.agent_id)

  addComment(
    db,
    ticketId,
    "system",
    "move",
    note ? `moved to ${column.name}: ${note}` : `moved to ${column.name}`,
  )

  if (column.prompt != null) projectClaim.broadcast(ticket.project_id, undefined)
  broadcastRoster()
  return getTicket(db, ticketId)!
}

export function cancelTicket(db: DB, ticketId: string): Ticket {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  db.query("UPDATE tickets SET state = 'failed', agent_id = NULL WHERE id = ?").run(ticketId)
  if (ticket.agent_id) {
    releaseAgent(db, ticket.agent_id)
    queueJob(db, ticket.agent_id, "cancel", ticketId)
  }
  addComment(db, ticketId, "system", "move", "cancelled by human")

  broadcastRoster()
  return getTicket(db, ticketId)!
}

export function takeoverTicket(db: DB, ticketId: string): Ticket {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  db.query("UPDATE tickets SET state = 'ready', agent_id = NULL WHERE id = ?").run(ticketId)
  if (ticket.agent_id) releaseAgent(db, ticket.agent_id)
  addComment(db, ticketId, "system", "move", "taken over by human (branch left in place)")

  broadcastRoster()
  return getTicket(db, ticketId)!
}

// Terminal failure (dirty slot, project mismatch). Moves to fail_column if set.
export function failTicket(db: DB, ticketId: string, reason: string): Ticket {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  const column = getColumn(db, ticket.column_id)
  const failColumn = column?.fail_column ? getColumn(db, column.fail_column) : null
  const target = failColumn && failColumn.project_id === ticket.project_id ? failColumn.id : ticket.column_id

  db.query("UPDATE tickets SET state = 'failed', agent_id = NULL, column_id = ? WHERE id = ?").run(
    target,
    ticketId,
  )
  if (ticket.agent_id) releaseAgent(db, ticket.agent_id)
  addComment(db, ticketId, "system", "comment", reason)

  broadcastRoster()
  return getTicket(db, ticketId)!
}

export function releaseAgent(db: DB, agentId: string): void {
  db.query("UPDATE agents SET status = 'idle', ticket_id = NULL, since = NULL WHERE id = ?").run(agentId)
}

// Queues a job for delivery on the agent's next claim, then wakes its poll.
export function queueJob(
  db: DB,
  agentId: string,
  type: "reply" | "permission" | "cancel",
  ticketId: string,
  payload?: string,
): void {
  db.query(
    "INSERT INTO jobs (agent_id, type, ticket_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(agentId, type, ticketId, payload ?? null, now())
  agentJobs.broadcast(agentId, undefined)
}
