# 03 — API Surface

Three endpoint groups, three trust levels. The server's entire external surface is
HTTP; there is no other interface.

## Trust model

| Group | Who calls | Auth | What it can do |
|---|---|---|---|
| **Agent-facing** | plugin's poll loop | agent id (registration) | register/deregister, claim, push events, post permission-request |
| **Plugin-facing** | plugin's `almadel_*` tools | **registration token** | read/comment/move/ask **its own ticket** |
| **Browser-facing** | the board UI | none (single-tenant, self-hosted) | full control: roster, tickets, replies, permissions, columns |

Two key rules from §8:

1. **The plugin-facing endpoints require the agent's registration token** — the
   token the agent never sees. A prompt-injected instruction to "POST to /move" has
   no credential to work with.
2. **Every plugin-facing endpoint is scoped to the ticket that token's agent
   currently holds.** An agent cannot touch another agent's ticket, even by id.

## Agent-facing

| Method | Path | Purpose | Body |
|---|---|---|---|
| `POST` | `/api/agents` | Register / upsert a slot | §3.2 registration body; returns `{ agent_id, name, port_base }` |
| `DELETE` | `/api/agents/{id}` | Deregister on shutdown | — (requeues held ticket immediately) |
| `POST` | `/api/claim` | Long poll (35s) | telemetry (§5.3); returns `Job` or `204` |
| `POST` | `/api/tickets/{id}/events` | Batched agent output | filtered, batched event list |
| `POST` | `/api/tickets/{id}/permission-request` | A permission hook fired | `{ tool, command }`; **blocks until decided** |

### The Job union

`/api/claim` returns a discriminated union — this is what makes blocked-resume work
over a pull-only channel:

```ts
type Job =
  | { type: "task";       project: string; ticket: string; prompt: string; branch: string }
  | { type: "reply";      project: string; ticket: string; text: string }
  | { type: "permission"; project: string; ticket: string;
      permission_id: string; decision: "allow" | "deny"; scope: Scope }
  | { type: "cancel";     project: string; ticket: string };
```

New tickets, replies into held sessions, and permission decisions all arrive
through this one channel. Every job carries `project` so the plugin can re-verify
(§3.1) before touching anything.

## Plugin-facing

Called by the tools underneath; **not agent-facing** — the agent never sees these
URLs.

| Method | Path | Purpose | Body |
|---|---|---|---|
| `GET` | `/api/tickets/{id}` | Ticket + thread | — |
| `POST` | `/api/tickets/{id}/comment` | Post a note or artifact | `{ kind, body }` |
| `POST` | `/api/tickets/{id}/move` | End the stage | `{ column, note }` |
| `POST` | `/api/tickets/{id}/ask` | Create a question; returns its id | `{ question }` |
| `GET` | `/api/questions/{qid}` | Long poll for the answer | — (see §12.6) |

All five are token-scoped and ticket-scoped as above.

## Browser-facing

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/p/{project}` | Board page |
| `GET` | `/join` | Enlistment page (§9.2) |
| `GET` | `/api/roster` | All projects, slots, `needs_you` count |
| `GET` | `/api/roster/stream` | SSE: presence and status changes |
| `GET` | `/api/tickets/{id}/stream` | SSE: replay from `events` at a `seq` offset |
| `POST` | `/api/tickets/{id}/reply` | Answer, or queue a nudge if busy |
| `POST` | `/api/tickets/{id}/permission` | `{ decision, scope }` |
| `POST` | `/api/tickets/{id}/cancel` | — |
| `POST` | `/api/tickets/{id}/takeover` | Mark human-owned, leave the branch in place |
| `GET`/`PUT` | `/api/projects/{id}/columns` | Read and edit the pipeline |

The browser never talks to opencode. Anything that can drive the browser API can
run arbitrary bash on the repo — which is fine: it's single-tenant and self-hosted,
and the boundary that matters is the plugin-facing one, not this one.

## Auth implementation

- **Registration token:** a `crypto.randomUUID()`-derived opaque string stored on
  the `agents` row at registration, returned once to the plugin, never logged,
  never stored elsewhere. Middleware on the plugin-facing group checks
  `Authorization: Bearer <token>` and resolves it to an `agent_id` + its current
  `ticket_id`.
- **Agent-facing group:** authenticated by `agent_id` in the path/body; the
  registration response returns the id the poll loop reuses. (The poll itself is
  trusted because it's the same machine that registered — single-tenant assumption.)
- **Browser-facing group:** no auth. Not exposed beyond the host in practice;
  document that anyone who can reach it owns the repo.

## Validation and errors

- Every request body is validated with the **shared zod schemas** (same ones the
  plugin uses to define its tools). Invalid → `400` with the zod issue list.
- Scoped operations on a ticket the token doesn't hold → `403`.
- Unknown ticket/project/question → `404`.
- Wrong project on a job → the *plugin* errors it back (the server doesn't enforce
  it mid-flight, by design §3.1); the server's claim query already filters by project.
- Capability/version mismatch at registration → `409` (§9.2, `08-registration-join-tokens.md`).

## SSE conventions

- `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
- Periodic `: ping` comment every ~15s to defeat idle-kill proxies.
- Ticket stream: `event: tick`, `data: { seq, kind, payload }`; reconnect with
  `?after=<seq>`.
- Roster stream: `event: roster`, `data: { ... }` on any presence/status change;
  client re-renders from `/api/roster` on reconnect.
