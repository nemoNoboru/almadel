import { broadcastRoster, broadcastTicket } from "../notify"
import { now } from "../db"
import type { DB } from "../db"
import { HttpError } from "../http-error"
import type { EventItem } from "../types"
import { getTicket } from "./tickets"

// Appends a batch of events, assigning the authoritative server sequence, then
// fans out to any open SSE subscribers for the ticket. The DB is the queue; the
// stream is only a view.
export function appendEvents(
  db: DB,
  ticketId: string,
  events: Array<{ kind: string; payload?: unknown }>,
): EventItem[] {
  const ticket = getTicket(db, ticketId)
  if (!ticket) throw new HttpError(404, "ticket not found")

  const rows: EventItem[] = []
  const ts = now()

  const run = db.transaction(() => {
    let seq = (
      db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE ticket_id = ?").get(ticketId) as { m: number }
    ).m

    const insert = db.query(
      "INSERT INTO events (ticket_id, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    for (const e of events) {
      seq += 1
      const payload = JSON.stringify(e.payload ?? null)
      insert.run(ticketId, seq, e.kind, payload, ts)
      rows.push({ seq, kind: e.kind, payload, created_at: ts })
    }
  })
  run()

  if (rows.length > 0) {
    broadcastTicket(ticketId, JSON.stringify(rows))
    broadcastRoster()
  }
  return rows
}

export function replayEvents(db: DB, ticketId: string, afterSeq: number): EventItem[] {
  return (
    db
      .query("SELECT * FROM events WHERE ticket_id = ? AND seq > ? ORDER BY seq ASC")
      .all(ticketId, afterSeq) as Record<string, unknown>[]
  ).map((r) => ({
    seq: r.seq as number,
    kind: r.kind as string,
    payload: (r.payload as string) ?? "",
    created_at: (r.created_at as number) ?? 0,
  }))
}
