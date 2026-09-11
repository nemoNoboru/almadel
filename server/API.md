# Almadel API contract

This is the **de-facto** contract implemented by `server/src/server/router.ts`. It
supersedes the design notes in `plan/03-api-surface.md` wherever the two differ.

Everything lives under `/api`. Non-`/api` paths fall through to static file
serving (the embedded web UI), then `404`.

## Conventions

- **Content type**: JSON (`application/json`) for all request/response bodies.
  `204 No Content` has an empty body.
- **Errors**: `{ "error": string, "issues": [{ "path": string, "message": string }] }`.
  `issues` is only populated for validation failures (Zod), and `path` is the
  dot-joined field path (e.g. `"capabilities.tools"`).
- **Status codes**:
  | Code | Meaning |
  |------|---------|
  | 200/201/204 | success |
  | 400 | invalid body (with `issues`) |
  | 401 | missing/invalid agent token |
  | 403 | agent does not hold the ticket / question |
  | 404 | unknown project, ticket, agent, or question |
  | 409 | registration/capability mismatch, WIP limit reached |
  | 500 | internal error |
- **SSE**: `text/event-stream`, `Cache-Control: no-cache`, keep-alive, heartbeat
  comment line `: ping` every ~15s. Streams close on client abort.

## Authentication

Three audiences, three identity schemes:

| Audience | Identity | Endpoints |
|----------|----------|-----------|
| Browser (human) | none | roster, board, move, reply, permission decision, cancel, takeover, columns |
| Plugin | `Authorization: Bearer <token>` (token from registration) | get ticket, comment, ask, question poll |
| Agent poll loop | `Bearer <token>` **or** `X-Almadel-Agent: <agent_id>` | claim, events, permission-request |

A `Bearer` token always identifies the agent that owns it; it never implies the
human is authorized for anything beyond that agent's own held ticket.

---

## Endpoints

### Browser-facing

#### `GET /api/roster`

Returns the presence view used by the UI.

```json
{
  "projects": [
    {
      "project": { "id": "almadel-api", "name": "almadel-api", "git_remote": null, "default_branch": "main", "created_at": 1700000000000 },
      "agents": [
        { "id": "agt_…", "name": "Uriel", "status": "working", "ticket_id": "TCK-412", "online": true, "…": "…" }
      ]
    }
  ],
  "needs_you": 0
}
```

`online` is derived: `last_poll` fresher than `leaseTtlMs`. `needs_you` counts
tickets whose state starts with `blocked`.

#### `GET /api/roster/stream`

SSE. Broadcasts `event: roster`, `data: {}` whenever the roster changes.

#### `GET /api/projects`

```json
[ { "id": "almadel-api", "name": "almadel-api" } ]
```

#### `GET /api/projects/{id}/board`

`404 project not found` if unknown. Otherwise `{ project, columns[], tickets[] }`.

#### `GET /api/projects/{id}/columns` / `PUT /api/projects/{id}/columns`

`PUT` replaces the entire column list (all-or-nothing). Body:

```json
{ "columns": [ { "id": "col-x", "name": "…", "prompt": "…|null", "next_column": "…|null", "fail_column": "…|null", "wip_limit": 2|null } ] }
```

`prompt === null` marks a human gate (never auto-claimed). `next_column` /
`fail_column` reference column **names**. Returns the new column list.

#### `POST /api/tickets`

Body: `{ "project_id", "title", "body?", "column_id" }` → `201` with the created
ticket. `400` with `issues` if invalid; `400 column out of scope` if the column
doesn't belong to the project.

#### `POST /api/tickets/draft`

Body: `{ "project_id", "agent_id", "instruction" }` → `{ "title", "body", "agent_name" }`.
`agent_id` may be unknown (then `agent_name` defaults to `"agent"`). `404` if the
project is unknown. This is a pure function — nothing is stored.

#### `GET /api/tickets/{id}`

Returns the thread `{ ticket, comments[], question, permission, pending[] }`.
`404 ticket not found` if unknown. If a `Bearer` token is present, the holder
must own the ticket (`401` invalid token, `403` not your ticket).

#### `GET /api/tickets/{id}/stream`

SSE. Replays stored events (see `POST …/events`) with `event: tick` and JSON
payloads, then streams new ones live. `?after=<seq>` resumes after the given
sequence number.

#### `POST /api/tickets/{id}/move`

Body: `{ "column", "note?" }` → the updated ticket. `409 wip_limit reached for X`
when the target column is at WIP. If a `Bearer` token is present, holder is checked.

#### `POST /api/tickets/{id}/reply`

Body: `{ "body" }` → `204`. Resolves a pending question, nudges a running session,
or just posts a comment.

#### `POST /api/tickets/{id}/permission`

Body: `{ "decision": "allow"|"deny", "scope": "once"|"always"|"session" }` → `204`.
`404 no pending permission` if there is nothing to decide.

#### `POST /api/tickets/{id}/cancel` / `POST /api/tickets/{id}/takeover`

`204`. Cancel marks the ticket `failed`; takeover marks it `ready` and releases
the agent.

---

### Agent-facing

#### `POST /api/agents`

Body: `{ "project", "repo_root", "git_remote?", "default_branch?", "label?", "opencode_version?", "capabilities?": { "tools?", "permission_hook?" } }`.

→ `200 { "agent_id", "name", "token", "port_base" }`.

- `404 project not found` — unknown project.
- `409` — `git_remote` mismatch, opencode version below `minOpencodeVersion`, or
  `capabilities.tools` missing.
- Re-registering the same `(project_id, repo_root, label)` upserts: keeps the
  display name and port band, issues a fresh `agent_id` + `token`.

#### `DELETE /api/agents/{id}`

`204` (or `404` if unknown). Requeues any ticket the agent held.

#### `POST /api/claim`

Long-poll. Body: `{ "project", "agent", "slot?": { "status", "ticket?", "since?" } }`.

- `404 unknown agent` if the agent id is unknown.
- Returns a job as soon as one is available, otherwise blocks (up to
  `pollWindowMs`) and returns `204` on timeout.
- Job union:
  ```ts
  | { type: "task",       project, ticket, prompt, branch }
  | { type: "reply",      project, ticket, text }
  | { type: "permission", project, ticket, permission_id, decision, scope }
  | { type: "cancel",     project, ticket }
  ```

#### `POST /api/tickets/{id}/events`

Body: `{ "events": [ { "kind", "payload?" } ] }` (max 1000). Appends and returns
the stored rows `[{ seq, kind, payload, created_at }]`. `payload` is serialized to
a JSON string on write. Requires agent identity (`401`), ticket exists (`404`),
and the agent holds the ticket (`403`).

#### `POST /api/tickets/{id}/permission-request`

Body: `{ "tool"?, "command"? }`. Requires the agent to hold the ticket. Blocks
until the human decides (up to `permissionTtlMs`):

- decided → `{ "decision": "allow"|"deny", "scope": "once"|"always"|"session" }`
- timed out → `{ "decision": "deny", "scope": "once", "timeout": true }`

---

### Plugin-facing (token-scoped)

#### `POST /api/tickets/{id}/comment`

Body: `{ "kind": "comment"|"plan"|"question"|"answer"|"permission"|"move", "body"? }`
→ `204`. Requires a valid `Bearer` token (`401`) and ticket ownership (`403`).

#### `POST /api/tickets/{id}/ask`

Body: `{ "question" }` → `{ "id" }`. Blocks the ticket on a question. Requires a
valid token and ownership.

#### `GET /api/questions/{qid}`

Long-poll for the answer. Requires a valid token. `404 question not found`,
`403 not your question` if the question belongs to a different ticket than the one
the agent currently holds. Returns `{ "answer" }`, or `204` when the poll times
out (the question is then marked deferred).

---

## Tick event kinds (informal)

Stored via `POST /api/tickets/{id}/events` and replayed on the ticket stream. The
server treats `kind` as an opaque string; the opencode plugin currently emits
tool-use/tool-result/status-style events with arbitrary `payload` objects.
