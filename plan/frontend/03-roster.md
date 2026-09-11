# 03 — The Roster

The roster is the left sidebar: agents grouped by project, with presence, plus
the global `Needs you` count. It is the only global surface — everything else
is project-scoped (§3.3).

```
┌─────────────┐
│ almadel-api │            project group
│ ● Alimiel   │            ● = online, ○ = offline
│   working   │            status line
│ ▲ Gediel    │            ▲ = blocked badge
│   blocked   │
│             │
│ almadel-web │
│ ○ Barachiel │
│   idle      │
│─────────────│
│ Needs you 1 │            global, spans all projects
└─────────────┘
```

## An agent is a slot (§5.1)

The roster key is the **slot**, not the session. One row = one opencode
instance = one checkout = one project. Sessions come and go per ticket; the
slot row is stable. The display name (e.g. "Gediel") survives restarts; the
agent id regenerates (§9.2). The roster must therefore treat the name as the
stable label and never surface the raw id to a human.

## Presence and status

Presence is **derived**, never stored (§7): online iff `last_poll` is fresh
(`now - last_poll < LEASE_TTL`, 90s). The roster renders it as a dot.

The `status` column is the *reported* telemetry. Status model (§5.2):

| Status | Meaning | UI |
|---|---|---|
| `offline` | hasn't polled in 90s | greyed dot, dim row, no thread |
| `idle` | free | dim row, no thread |
| `working` | running a turn | green, live log available, compose queues |
| `blocked_question` | called `almadel_ask` | **amber + badge**, opens compose |
| `blocked_permission` | paused awaiting approval | **amber + badge**, opens allow/deny buttons |
| `failed` | last run errored | red, thread readable |

Two blocked flavours are deliberately distinct (§5.2): a question wants prose,
a permission wants a decision. The roster shows both amber, but the
conversation pane renders them differently (`04-conversation.md`).

### Where the status comes from (§5.3)

- **Detection** is immediate via push (a question/permission POSTs the moment it
  fires) — sub-second.
- **Telemetry** is the poll backstop, up to 35s stale. It can never drive the
  amber badge; it only reconciles.

The UI does not distinguish these — it renders the server's stored status. The
`blocked` badge is *only* lit by detection (the amber state), never by stale
telemetry. This falls out of the server writing `state=blocked_*` only on the
push path.

## The `Needs you` count (§5.4)

Rendered from a query, never an event counter:

```sql
SELECT count(*) FROM tickets WHERE state LIKE 'blocked%';
```

It spans all projects (§3.3). A refresh or a dropped SSE connection must never
lose the count — on reconnect the roster re-fetches `/api/roster` and the count
is correct because it was never in the browser. The SSE roster tick only says
"re-render"; the count always comes from the query.

## Clicking an agent

Clicking an agent row selects it and opens the conversation pane to the ticket
that agent currently holds:

- `blocked_question` / `blocked_permission` → the blocked ticket's thread with
  the compose box or allow/deny buttons live.
- `working` → the live log, compose box queuing a pending message (§5.5).
- `idle` / `offline` → read-only history (or nothing, if the agent holds no
  ticket).
- `failed` → the errored ticket's thread, readable.

Clicking a **project header** selects that project's board (project switcher),
but does not change the conversation pane unless the pinned ticket belongs to a
different project.

## Grouping and ordering

Agents are grouped by project. Projects are ordered by name; agents within a
project by status severity (blocked first, then working, idle, offline) then by
name. Blocked agents float to the top of their group so a stuck agent is seen
immediately.

## Live updates

The roster subscribes to `GET /api/roster/stream` (SSE). On a `roster` event it
re-fetches `/api/roster` and swaps the fragment — the stream is a hint, the
query is the truth. Details in `07-events-and-live-log.md`.
