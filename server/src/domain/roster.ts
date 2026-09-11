import type { DB } from "../db"
import { HttpError } from "../http-error"
import type { PendingMessage, Roster, TicketThread } from "../types"
import { getAgent } from "./agents"
import { getOpenPermission, getOpenQuestion } from "./blocking"
import { getTicket, listComments, listProjects } from "./tickets"

export function needsYou(db: DB): number {
  const row = db.query("SELECT count(*) AS n FROM tickets WHERE state LIKE 'blocked%'").get() as { n: number }
  return row.n
}

export function roster(db: DB, leaseTtlMs: number): Roster {
  const threshold = Date.now() - leaseTtlMs
  const projects = listProjects(db).map((project) => {
    const agents = (
      db.query("SELECT * FROM agents WHERE project_id = ? ORDER BY registered_at ASC").all(project.id) as Record<string, unknown>[]
    ).map((row) => {
      const agent = getAgent(db, row.id as string)!
      const online = agent.last_poll != null && agent.last_poll >= threshold
      return { ...agent, online }
    })
    return { project, agents }
  })

  return { projects, needs_you: needsYou(db) }
}

export function thread(db: DB, ticketId: string): TicketThread {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  const pending = (
    db
      .query("SELECT * FROM pending_messages WHERE ticket_id = ? ORDER BY created_at ASC")
      .all(ticketId) as Record<string, unknown>[]
  ).map(mapPending)

  return {
    ticket,
    comments: listComments(db, ticketId),
    question: getOpenQuestion(db, ticketId),
    permission: getOpenPermission(db, ticketId),
    pending,
  }
}

function mapPending(row: Record<string, unknown>): PendingMessage {
  return {
    id: row.id as number,
    ticket_id: row.ticket_id as string,
    body: row.body as string,
    created_at: (row.created_at as number) ?? 0,
    sent_at: (row.sent_at as number | null) ?? null,
  }
}
