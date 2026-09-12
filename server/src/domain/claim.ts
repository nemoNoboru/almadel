import { broadcastRoster } from "../notify"
import { now } from "../db"
import type { DB } from "../db"
import type { Job, PermissionDecision, PermissionScope, Ticket } from "../types"
import { getAgent } from "./agents"
import { getColumn, getProject, getTicket, listComments, mapTicket } from "./tickets"
import { buildThread, renderPrompt } from "../prompt"

const CLAIM_SELECT = `
  SELECT t.*, c.prompt AS column_prompt
  FROM tickets t
  JOIN columns c ON c.id = t.column_id
  WHERE t.project_id = ? AND t.state = 'ready' AND c.prompt IS NOT NULL
    AND (c.wip_limit IS NULL OR (
      SELECT count(*) FROM tickets t2
      WHERE t2.column_id = c.id AND (t2.state = 'running' OR t2.state LIKE 'blocked%')
    ) < c.wip_limit)
  ORDER BY t.priority DESC, t.created_at ASC
  LIMIT 1
`

interface ClaimRow {
  id: string
  project_id: string
  title: string
  body: string | null
  column_id: string
  state: string
  branch: string | null
  agent_id: string | null
  priority: number
  claimed_at: number | null
  created_at: number
  column_prompt: string | null
}

// Atomic claim. Runs entirely synchronously on the bun:sqlite connection — the
// "never await inside the claim transaction" rule (§2.9). Returns the claimed
// ticket or null.
export function claimNow(db: DB, projectId: string, agentId: string): Ticket | null {
  const run = db.transaction(() => {
    // An agent already holding a ticket (working or blocked) never claims a
    // second one — new work waits for the slot to be recycled (§11.9). After a
    // move the agent has no ticket but a non-idle status (the plugin reports
    // idle only once its session has actually finished), so gate on status too:
    // no new task until the slot flips back to idle.
    const held = db.query("SELECT ticket_id, status FROM agents WHERE id = ?").get(agentId) as
      | { ticket_id: string | null; status: string }
      | undefined
    if (held?.ticket_id || held?.status !== "idle") return null

    const row = db.query(CLAIM_SELECT).get(projectId) as ClaimRow | undefined
    if (!row) return null

    const branch = `run/${row.id}`
    const ts = now()

    const res = db
      .query(
        "UPDATE tickets SET state = 'running', agent_id = ?, claimed_at = ?, branch = COALESCE(branch, ?) WHERE id = ? AND state = 'ready'",
      )
      .run(agentId, ts, branch, row.id)
    if (res.changes === 0) return null

    db.query("UPDATE agents SET status = 'working', ticket_id = ?, since = ? WHERE id = ?").run(
      row.id,
      ts,
      agentId,
    )

    db.query(
      "INSERT INTO comments (ticket_id, author, kind, body, created_at) VALUES (?, 'system', 'move', ?, ?)",
    ).run(row.id, `claimed by agent ${agentId}`, ts)

    return getTicket(db, row.id as string)
  })
  const ticket = run()
  if (ticket) broadcastRoster()
  return ticket
}

// Delivers a pending outbox job (reply / permission / cancel) if one is queued
// for this agent, marking it delivered atomically.
export function nextJob(db: DB, agentId: string): Job | null {
  const run = db.transaction(() => {
    const row = db
      .query("SELECT * FROM jobs WHERE agent_id = ? AND delivered_at IS NULL ORDER BY id ASC LIMIT 1")
      .get(agentId) as
      | { id: number; type: string; ticket_id: string; payload: string | null }
      | undefined
    if (!row) return null

    db.query("UPDATE jobs SET delivered_at = ? WHERE id = ?").run(now(), row.id)

    if (row.type === "message") {
      const agent = getAgent(db, agentId)
      return {
        type: "message",
        project: agent?.project_id ?? "",
        text: (row.payload as string | null) ?? "",
      } satisfies Job
    }

    const ticket = getTicket(db, row.ticket_id)
    if (!ticket) return null

    const project = ticket.project_id
    switch (row.type) {
      case "reply": {
        const text = (row.payload as string | null) ?? ""
        return { type: "reply", project, ticket: ticket.id, text } satisfies Job
      }
      case "permission": {
        const payload = JSON.parse((row.payload as string) || "{}") as {
          permission_id: string
          decision: PermissionDecision
          scope: PermissionScope
        }
        return {
          type: "permission",
          project,
          ticket: ticket.id,
          permission_id: payload.permission_id,
          decision: payload.decision,
          scope: payload.scope,
        } satisfies Job
      }
      case "cancel":
        return { type: "cancel", project, ticket: ticket.id } satisfies Job
      default:
        return null
    }
  })
  return run()
}

export function makeTaskJob(db: DB, ticket: Ticket, agentId: string): Job {
  const column = getColumn(db, ticket.column_id)
  const agent = getAgent(db, agentId)
  const project = getProject(db, ticket.project_id)
  const comments = listComments(db, ticket.id)

  const vars: Record<string, string> = {
    "ticket.id": ticket.id,
    "ticket.title": ticket.title,
    "ticket.body": ticket.body ?? "",
    thread: buildThread(comments),
    branch: ticket.branch ?? `run/${ticket.id}`,
    "base_sha": ticket.head_sha ?? "",
    project: ticket.project_id,
    remote: project?.git_remote ?? "",
    port_base: String(agent?.port_base ?? ""),
  }

  const prompt = column?.prompt ? renderPrompt(column.prompt, vars) : ""

  return {
    type: "task",
    project: ticket.project_id,
    ticket: ticket.id,
    prompt,
    branch: ticket.branch ?? `run/${ticket.id}`,
    model: column?.model ?? null,
    base_sha: ticket.head_sha,
  }
}
