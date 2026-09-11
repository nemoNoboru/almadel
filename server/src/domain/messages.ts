import { now } from "../db"
import type { DB } from "../db"
import { agentJobs } from "../notify"
import type { Message, MessageAuthor } from "../types"

export function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as number,
    agent_id: row.agent_id as string,
    author: row.author as MessageAuthor,
    body: row.body as string,
    created_at: (row.created_at as number) ?? 0,
  }
}

export function listMessages(db: DB, agentId: string): Message[] {
  const rows = db
    .query("SELECT * FROM messages WHERE agent_id = ? ORDER BY created_at ASC, id ASC")
    .all(agentId) as Record<string, unknown>[]
  return rows.map(mapMessage)
}

function insertMessage(db: DB, agentId: string, author: MessageAuthor, body: string): Message {
  const res = db
    .query("INSERT INTO messages (agent_id, author, body, created_at) VALUES (?, ?, ?, ?)")
    .run(agentId, author, body, now())
  const row = db
    .query("SELECT * FROM messages WHERE id = ?")
    .get(Number(res.lastInsertRowid)) as Record<string, unknown>
  return mapMessage(row)
}

// A human message both stores the message and queues a "message" job so the
// agent's long-poll claim wakes up and delivers it to the model.
export function sendHumanMessage(db: DB, agentId: string, body: string): Message {
  const message = insertMessage(db, agentId, "human", body)
  db.query(
    "INSERT INTO jobs (agent_id, type, ticket_id, payload, created_at) VALUES (?, 'message', '', ?, ?)",
  ).run(agentId, body, now())
  agentJobs.broadcast(agentId, undefined)
  return message
}

export function sendAgentMessage(db: DB, agentId: string, body: string): Message {
  return insertMessage(db, agentId, "agent", body)
}
