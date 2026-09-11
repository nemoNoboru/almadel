import { broadcastRoster, permissionDecision, projectClaim } from "../notify"
import { now } from "../db"
import type { DB } from "../db"
import type { Config } from "../config"
import { addComment, queueJob } from "./tickets"

// One timer, two jobs (§10): lease expiry and permission auto-deny. Idempotent
// and re-runnable — a crash mid-sweep just re-runs on the next tick.
export function sweep(db: DB, config: Config): void {
  const ts = now()

  // 1. Lease expiry: agents that stopped polling must not strand their ticket.
  const staleThreshold = ts - config.leaseTtlMs
  const staleAgents = db
    .query("SELECT * FROM agents WHERE last_poll IS NOT NULL AND last_poll < ?")
    .all(staleThreshold) as Record<string, unknown>[]

  for (const agentRow of staleAgents) {
    const agentId = agentRow.id as string
    const ticketId = agentRow.ticket_id as string | null
    if (ticketId) {
      const res = db
        .query(
          "UPDATE tickets SET state = 'ready', agent_id = NULL, claimed_at = NULL WHERE id = ? AND state IN ('running', 'blocked_question', 'blocked_permission')",
        )
        .run(ticketId)
      if (res.changes > 0) {
        addComment(db, ticketId, "system", "comment", "agent vanished, requeued")
        projectClaim.broadcast((agentRow.project_id as string) ?? "", undefined)
      }
    }
    db.query("UPDATE agents SET status = 'idle', ticket_id = NULL, since = NULL WHERE id = ?").run(agentId)
  }

  // 2. Permission auto-deny: nothing pends silently forever (§12.5).
  const permissionThreshold = ts - config.permissionTtlMs
  const stalePermissions = db
    .query("SELECT * FROM permissions WHERE decision IS NULL AND created_at < ?")
    .all(permissionThreshold) as Record<string, unknown>[]

  for (const permRow of stalePermissions) {
    const permissionId = permRow.id as string
    const ticketId = permRow.ticket_id as string

    db.query("UPDATE permissions SET decision = 'deny', scope = 'once', decided_at = ? WHERE id = ?").run(ts, permissionId)
    db.query("UPDATE tickets SET state = 'running' WHERE id = ?").run(ticketId)
    const ticket = db.query("SELECT agent_id FROM tickets WHERE id = ?").get(ticketId) as
      | { agent_id: string | null }
      | undefined
    if (ticket?.agent_id) db.query("UPDATE agents SET status = 'working' WHERE id = ?").run(ticket.agent_id)

    addComment(
      db,
      ticketId,
      "system",
      "permission",
      `auto-denied after ${Math.round(config.permissionTtlMs / 60_000)}m: ${permRow.command ?? permRow.tool ?? ""}`,
    )

    const delivered = permissionDecision.broadcast(permissionId, { decision: "deny", scope: "once" })
    if (!delivered && ticket?.agent_id) {
      queueJob(db, ticket.agent_id, "permission", ticketId, JSON.stringify({ permission_id: permissionId, decision: "deny", scope: "once" }))
    }
  }

  if (staleAgents.length > 0 || stalePermissions.length > 0) broadcastRoster()
}
