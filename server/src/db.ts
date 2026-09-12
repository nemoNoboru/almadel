import { Database } from "bun:sqlite"
import type { Column, Comment, Project } from "./types"

export type DB = Database

// Versioned, forward-only migrations. Phase 1 ships 0001 = the full schema.
const MIGRATIONS: string[] = [`
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  git_remote     TEXT,
  default_branch TEXT DEFAULT 'main',
  created_at     INTEGER
);

CREATE TABLE columns (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  prompt      TEXT,
  next_column TEXT,
  fail_column TEXT,
  wip_limit   INTEGER
);

CREATE TABLE tickets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT,
  column_id   TEXT NOT NULL,
  state       TEXT NOT NULL,
  branch      TEXT,
  agent_id    TEXT,
  priority    INTEGER DEFAULT 0,
  claimed_at  INTEGER,
  created_at  INTEGER
);
CREATE INDEX idx_claim ON tickets(project_id, state, priority, created_at);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT NOT NULL,
  author     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT,
  created_at INTEGER
);
CREATE INDEX idx_comments_ticket ON comments(ticket_id, created_at);

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT,
  label            TEXT,
  repo_root        TEXT,
  status           TEXT NOT NULL,
  ticket_id        TEXT,
  since            INTEGER,
  last_poll        INTEGER,
  opencode_version TEXT,
  registered_at    INTEGER,
  token            TEXT,
  port_base        INTEGER
);
CREATE UNIQUE INDEX idx_agents_slot ON agents(project_id, repo_root, label);

CREATE TABLE permissions (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  tool       TEXT,
  command    TEXT,
  decision   TEXT,
  scope      TEXT,
  created_at INTEGER,
  decided_at INTEGER
);

CREATE TABLE questions (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  answer      TEXT,
  deferred    INTEGER DEFAULT 0,
  created_at  INTEGER,
  answered_at INTEGER
);

CREATE TABLE pending_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER,
  sent_at    INTEGER
);

CREATE TABLE events (
  ticket_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT,
  created_at INTEGER,
  PRIMARY KEY (ticket_id, seq)
);

CREATE TABLE join_tokens (
  token      TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  expires_at INTEGER,
  revoked    INTEGER DEFAULT 0
);

CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     TEXT NOT NULL,
  type         TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  payload      TEXT,
  created_at   INTEGER,
  delivered_at INTEGER
);
CREATE INDEX idx_jobs_agent ON jobs(agent_id, id);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`,
`
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER
);
CREATE INDEX idx_messages_agent ON messages(agent_id, created_at);
`,
`
ALTER TABLE comments ADD COLUMN updated_at INTEGER;
`,
`
ALTER TABLE columns ADD COLUMN model TEXT;
`,
`
ALTER TABLE tickets ADD COLUMN head_sha TEXT;
`,
]

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA busy_timeout = 5000;")
  migrate(db)
  return db
}

export function migrate(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER)",
  )
  const applied = new Set(
    (db.query("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  )
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1
    if (applied.has(version)) continue
    const run = db.transaction(() => {
      db.exec(MIGRATIONS[i]!)
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        Date.now(),
      )
    })
    run()
  }
}

// ---------------------------------------------------------------------------
// Small helpers shared by the domain layer.
// ---------------------------------------------------------------------------

export function now(): number {
  return Date.now()
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
}

const ANGELS = [
  "Alimiel",
  "Gabriel",
  "Barachiel",
  "Gediel",
  "Raphael",
  "Michael",
  "Uriel",
  "Raguel",
  "Sariel",
  "Remiel",
  "Anael",
  "Cassiel",
  "Sachiel",
  "Zadkiel",
  "Haniel",
  "Jophiel",
  "Chamuel",
  "Azrael",
  "Metatron",
  "Sandalphon",
]

export function nextAngelName(db: Database, projectId: string): string {
  const used = new Set(
    (
      db.query("SELECT name FROM agents WHERE project_id = ?").all(projectId) as {
        name: string | null
      }[]
    )
      .map((r) => r.name)
      .filter((n): n is string => n != null),
  )
  for (const name of ANGELS) if (!used.has(name)) return name
  return `${ANGELS[0]}${used.size + 1}`
}

export function nextTicketId(db: Database): string {
  const run = db.transaction(() => {
    const row = db.query("SELECT value FROM meta WHERE key = 'ticket_seq'").get() as
      | { value: string }
      | undefined
    const next = row ? Number.parseInt(row.value, 10) + 1 : 412
    db.query("INSERT INTO meta (key, value) VALUES ('ticket_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(next),
    )
    return `TCK-${next}`
  })
  return run()
}

// ---------------------------------------------------------------------------
// Seeding: a fresh DB gets one default project with the §4.1 board.
// ---------------------------------------------------------------------------

// The default §4.1 board: 7 columns (Spec → Planning → Review → Implement →
// Testing → Done/Failed). next_column / fail_column reference column *names*
// (per vision.md §4.1), which is also what the column editor sends on save.
export interface DefaultColumn {
  name: string
  prompt: string | null
  next: string | null
  fail: string | null
  wip: number | null
}

export const DEFAULT_BOARD_COLUMNS: DefaultColumn[] = [
  { name: "Spec", prompt: null, next: "Planning", fail: null, wip: null },
  { name: "Planning", prompt: "Read ticket {{ticket.id}} and produce an implementation plan.\nDo not write code. Post the plan with kind=\"plan\", then move to Review.", next: "Review", fail: "Failed", wip: 2 },
  { name: "Review", prompt: null, next: "Implement", fail: null, wip: null },
  { name: "Implement", prompt: "Ticket {{ticket.id}}. The approved plan is in the thread below.\nImplement it on branch {{branch}}. Run the test suite before finishing.\nDev servers must bind ports starting at {{port_base}}.\nCommit your work on {{branch}}, push it, and open a pull request. Remote: {{remote}}.", next: "Testing", fail: "Failed", wip: 2 },
  { name: "Testing", prompt: "Ticket {{ticket.id}}. Verify the change on branch {{branch}}.\nRun the full test suite. Report results, then move to Done.\nCommit any fixes on {{branch}} and push them.", next: "Done", fail: "Failed", wip: 2 },
  { name: "Done", prompt: null, next: null, fail: null, wip: null },
  { name: "Failed", prompt: null, next: null, fail: null, wip: null },
]

export function insertDefaultBoard(db: Database, projectId: string, ids?: string[]): void {
  DEFAULT_BOARD_COLUMNS.forEach((col, position) => {
    const id = ids?.[position] ?? newId("col")
    db.query(
      "INSERT INTO columns (id, project_id, name, position, prompt, next_column, fail_column, wip_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, projectId, col.name, position, col.prompt, col.next, col.fail, col.wip)
  })
}

export function seed(db: Database): void {
  const count = (db.query("SELECT count(*) AS n FROM projects").get() as { n: number }).n
  if (count > 0) return

  const run = db.transaction(() => {
    const projectId = "almadel-api"
    const ts = now()

    db.query(
      "INSERT INTO projects (id, name, git_remote, default_branch, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(projectId, "almadel-api", null, "main", ts)

    insertDefaultBoard(db, projectId, [
      "col-spec",
      "col-planning",
      "col-review",
      "col-implement",
      "col-testing",
      "col-done",
      "col-failed",
    ])
  })
  run()
}

// Convenience row mappers.
export function mapProject(row: Record<string, unknown> | null | undefined): Project | null {
  if (!row) return null
  return {
    id: row.id as string,
    name: row.name as string,
    git_remote: (row.git_remote as string | null) ?? null,
    default_branch: (row.default_branch as string) ?? "main",
    created_at: (row.created_at as number) ?? 0,
  }
}

export function mapColumn(row: Record<string, unknown> | null | undefined): Column | null {
  if (!row) return null
  return {
    id: row.id as string,
    project_id: row.project_id as string,
    name: row.name as string,
    position: (row.position as number) ?? 0,
    prompt: (row.prompt as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    next_column: (row.next_column as string | null) ?? null,
    fail_column: (row.fail_column as string | null) ?? null,
    wip_limit: (row.wip_limit as number | null) ?? null,
  }
}

export function mapComment(row: Record<string, unknown> | null | undefined): Comment | null {
  if (!row) return null
  return {
    id: row.id as number,
    ticket_id: row.ticket_id as string,
    author: row.author as Comment["author"],
    kind: row.kind as Comment["kind"],
    body: (row.body as string | null) ?? null,
    created_at: (row.created_at as number) ?? 0,
    updated_at: (row.updated_at as number | null) ?? null,
  }
}
