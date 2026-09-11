# 02 — Data Model

SQLite, WAL mode. `bun:sqlite` is synchronous so transactions are atomic by
construction — provided nothing `await`s inside one. Schema below is the source of
truth from `vision.md` §7, reproduced here with the notes the server needs.

## Schema

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,   -- almadel-api
  name          TEXT NOT NULL,
  git_remote    TEXT,               -- checked at registration
  default_branch TEXT DEFAULT 'main',
  created_at    INTEGER
);

CREATE TABLE columns (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  prompt      TEXT,               -- NULL = human gate
  next_column TEXT,
  fail_column TEXT,
  wip_limit   INTEGER
);

CREATE TABLE tickets (
  id          TEXT PRIMARY KEY,   -- TCK-412
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  body        TEXT,
  column_id   TEXT NOT NULL,
  state       TEXT NOT NULL,      -- ready | running | blocked_question
                                  -- | blocked_permission | done | failed
  branch      TEXT,
  agent_id    TEXT,
  priority    INTEGER DEFAULT 0,
  claimed_at  INTEGER,
  created_at  INTEGER
);

CREATE INDEX idx_claim ON tickets(project_id, state, priority, created_at);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  author     TEXT NOT NULL,       -- human | agent | system
  kind       TEXT NOT NULL,       -- comment | plan | question | answer
                                  -- | permission | move
  body       TEXT,
  created_at INTEGER
);

-- One row per slot, not per process: upserted on (project_id, repo_root, label)
-- so restarts reuse the row instead of leaving ghosts (§9.2).
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  name          TEXT,             -- "Gediel"
  label         TEXT,             -- "laptop"
  repo_root     TEXT,
  status        TEXT NOT NULL,
  ticket_id     TEXT,
  since         INTEGER,
  last_poll     INTEGER,
  opencode_version TEXT,          -- checked at join (§9.2)
  registered_at INTEGER
);

CREATE UNIQUE INDEX idx_agents_slot ON agents(project_id, repo_root, label);

CREATE TABLE permissions (
  id          TEXT PRIMARY KEY,   -- prm_91, from opencode
  ticket_id   TEXT NOT NULL,
  tool        TEXT,
  command     TEXT,               -- shown in the UI
  decision    TEXT,               -- NULL until answered
  scope       TEXT,               -- once | always | session
  created_at  INTEGER,
  decided_at  INTEGER
);

CREATE TABLE questions (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  answer     TEXT,
  deferred   INTEGER DEFAULT 0,   -- tool timed out; answer goes via injection
  created_at INTEGER,
  answered_at INTEGER
);

CREATE TABLE pending_messages (
  id         INTEGER PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER,
  sent_at    INTEGER              -- NULL until delivered
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
  project_id TEXT NOT NULL REFERENCES projects(id),
  expires_at INTEGER,
  revoked    INTEGER DEFAULT 0
);
```

## Notes that matter for the code

### Presence is derived, never stored

`agents.status` is the *reported* status (telemetry); "online" is **not** a column.
An agent is online iff `last_poll` is fresh (`now - last_poll < LEASE_TTL`).
Nothing ever writes `offline` — the roster query derives it.

### Events use a composite sequence, not a global id

`PRIMARY KEY (ticket_id, seq)`. `seq` is a monotonically increasing integer per
ticket. A reconnecting browser asks for `/api/tickets/{id}/stream?after=<seq>` and
gets exactly what it missed. This is what makes replay work without a cursor table.

### Tickets are the durable artifact

`comments` holds plans, questions, answers, permission decisions, moves. The
`{{thread}}` prompt variable and the roster's conversation view are both just reads
of `comments` in `created_at` order. There is no separate "session" or "log" table
— a session's transcript that matters is written back as comments/events; the
transient transcript lives only in opencode.

## WAL and pragmas

```ts
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");
```

- **WAL** gives readers (SSE fan-out, roster queries) concurrency with the writer.
- **foreign_keys = ON** — project scoping is a referential integrity concern, not
  just an app-level filter. (SQLite defaults this OFF; turning it on is deliberate.)
- **busy_timeout** bounds contention on the rare concurrent write.

## Migrations

Versioned, forward-only. A `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)`
table plus an ordered list of migration SQL strings applied in a transaction each.
Phase 1 ships migration `0001` = the full schema above. Subsequent phases add
migrations as the schema grows (e.g. `port_base` on `projects` or `agents` if it
lands outside Phase 1).

Guideline: schema changes ride with the phase that needs them; never a
half-applied migration. `bun build --compile` embeds the migration list so a single
binary can bootstrap a fresh DB.

## Seeding

`almadel init` (or first start with an empty DB) creates one project with a default
board. The default column set from §4.1:

```
Spec (prompt: null, human gate) → Planning (prompt, next: Review)
Review (prompt: null) → Implement (prompt, next: Testing, fail: Failed)
Testing (prompt, fail: Failed) → Done
```

The "Done" and "Failed" columns are terminal: `next_column` is null and nothing
auto-dispatches from them.

## State machine (tickets.state)

```
ready ──claim──▶ running ──move──▶ (next column, state=ready)
                          ──ask──▶ blocked_question ──answer──▶ running
                          ──permission──▶ blocked_permission ──decide──▶ running
                          ──idle no move──▶ (server fallback move, §2.6)
                          ──cancel──▶ done/failed (human-owned)
                          ──error/lease──▶ ready (requeue)
```

Transitions are centralized in `domain/tickets.ts` so no route mutates `state` ad hoc.
