import { broadcastRoster } from "../notify"
import { newId, now } from "../db"
import type { DB } from "../db"
import { HttpError } from "../http-error"
import type { Agent, AgentStatus } from "../types"

export interface RegistrationInput {
  project: string
  repo_root: string
  git_remote?: string
  default_branch?: string
  label?: string
  opencode_version?: string
  capabilities?: { tools?: boolean; permission_hook?: boolean }
}

export interface RegistrationResult {
  agent_id: string
  name: string
  token: string
  port_base: number
}

export interface SlotTelemetry {
  status: string
  ticket?: string | null
  since?: number | null
}

export function mapAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    name: (row.name as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    repo_root: (row.repo_root as string | null) ?? null,
    status: (row.status as AgentStatus) ?? "idle",
    ticket_id: (row.ticket_id as string | null) ?? null,
    since: (row.since as number | null) ?? null,
    last_poll: (row.last_poll as number | null) ?? null,
    opencode_version: (row.opencode_version as string | null) ?? null,
    registered_at: (row.registered_at as number) ?? 0,
    port_base: (row.port_base as number | null) ?? null,
  }
}

export function getAgent(db: DB, id: string): Agent | null {
  const row = db.query("SELECT * FROM agents WHERE id = ?").get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return mapAgent(row)
}

export function getAgentByToken(db: DB, token: string): Agent | null {
  const row = db.query("SELECT * FROM agents WHERE token = ?").get(token) as Record<string, unknown> | undefined
  if (!row) return null
  return mapAgent(row)
}

// Registration per §08: project binding, remote check, capability gate, then a
// slot upsert keyed on (project_id, repo_root, label) so restarts reuse the row.
export function registerAgent(
  db: DB,
  input: RegistrationInput,
  config: { minOpencodeVersion: string; portBase: number; portBandWidth: number },
): RegistrationResult {
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(input.project) as
    | Record<string, unknown>
    | undefined
  if (!project) throw new HttpError(404, "project not found")

  const remote = (project.git_remote as string | null) ?? null
  if (remote && input.git_remote && input.git_remote !== remote) {
    throw new HttpError(409, "registration mismatch: git_remote does not match the project")
  }

  const version = input.opencode_version ?? "0.0.0"
  if (versionLessThan(version, config.minOpencodeVersion)) {
    throw new HttpError(
      409,
      `almadel requires opencode >= ${config.minOpencodeVersion} with plugin tool support. found ${version} — upgrade and restart.`,
    )
  }
  if (input.capabilities?.tools !== true) {
    throw new HttpError(409, "almadel requires plugin tool support (capabilities.tools)")
  }

  const label = input.label ?? "default"

  return db.transaction(() => {
    const existing = db
      .query("SELECT * FROM agents WHERE project_id = ? AND repo_root = ? AND label = ?")
      .get(input.project, input.repo_root, label) as
      | { id: string; name: string | null; port_base: number | null }
      | undefined

    const token = newId("tok")
    const ts = now()

    if (existing) {
      // Reuse the slot: keep the id (stable identity, so history/messages survive
      // restarts) and the port band, rotate only the token.
      db.query(
        `UPDATE agents SET token = ?, opencode_version = ?, registered_at = ?, last_poll = ? WHERE id = ?`,
      ).run(token, version, ts, ts, existing.id)
      return {
        agent_id: existing.id,
        name: (existing.name as string) ?? "agent",
        token,
        port_base: (existing.port_base as number) ?? config.portBase,
      }
    }

    const id = newId("agt")
    const name = label
    const portBase = allocatePortBand(db, input.project, config.portBase, config.portBandWidth)

    db.query(
      `INSERT INTO agents (id, project_id, name, label, repo_root, status, ticket_id, since, last_poll, opencode_version, registered_at, token, port_base)
       VALUES (?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?, ?, ?, ?)`,
    ).run(id, input.project, name, label, input.repo_root, ts, version, ts, token, portBase)

    broadcastRoster()
    return { agent_id: id, name, token, port_base: portBase }
  })()
}

function allocatePortBand(db: DB, projectId: string, base: number, width: number): number {
  const rows = db
    .query("SELECT port_base FROM agents WHERE project_id = ? AND port_base IS NOT NULL ORDER BY port_base ASC")
    .all(projectId) as { port_base: number }[]
  const used = new Set(rows.map((r) => r.port_base))
  let slot = 0
  let candidate = base + slot * width
  while (used.has(candidate)) {
    slot += 1
    candidate = base + slot * width
  }
  return candidate
}

// Telemetry rides the poll (§5.3). The push endpoints win on latency; this is
// the reconciliation backstop — never the badge source.
export function updateTelemetry(db: DB, agentId: string, telemetry: SlotTelemetry | undefined): void {
  const ts = now()
  if (telemetry && isStatus(telemetry.status)) {
    db.query("UPDATE agents SET status = ?, ticket_id = ?, since = ?, last_poll = ? WHERE id = ?").run(
      telemetry.status,
      telemetry.ticket ?? null,
      telemetry.since ?? null,
      ts,
      agentId,
    )
  } else {
    db.query("UPDATE agents SET last_poll = ? WHERE id = ?").run(ts, agentId)
  }
}

function isStatus(s: string): boolean {
  return ["idle", "working", "blocked_question", "blocked_permission", "failed"].includes(s)
}

// Deregister on shutdown (/almadel leave). Requeues the held ticket immediately.
export function deregisterAgent(db: DB, id: string): void {
  const agent = getAgent(db, id)
  if (!agent) throw new HttpError(404, "agent not found")

  db.transaction(() => {
    if (agent.ticket_id) {
      db.query(
        "UPDATE tickets SET state = 'ready', agent_id = NULL, claimed_at = NULL WHERE id = ? AND state IN ('running', 'blocked_question', 'blocked_permission')",
      ).run(agent.ticket_id)
    }
    db.query("DELETE FROM agents WHERE id = ?").run(id)
  })()

  broadcastRoster()
}

function versionLessThan(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}
