# 07 — Roster & Presence

The roster is a sidebar of agents with presence, grouped by project. It is *not* a
session list — sessions are ephemeral; a **slot** is stable (§5.1).

## An agent is a slot, not a session

Sessions are created and destroyed per ticket. A slot is one opencode instance, one
checkout, one project, present as long as it polls. The roster is keyed by slot.
Display names help: `Alimiel`, `Gabriel`, `Barachiel`, `Gediel` (more sayable than
`laptop/2`).

## `agents` table and upsert semantics

One row per slot, upserted on `(project_id, repo_root, label)` (§9.2):

```sql
CREATE UNIQUE INDEX idx_agents_slot ON agents(project_id, repo_root, label);
```

A worker restarted ten times reuses one row: same directory → same slot → same
display name, new agent id, new token. No ghosts in the roster.

## Status model

| Status | Meaning | UI |
|---|---|---|
| `offline` | Hasn't polled in 90s | Greyed, no thread |
| `idle` | Free | Dim, no thread |
| `working` | Running a turn | Green, live log, compose queues |
| `blocked_question` | Called `/ask` | Amber + badge, compose box |
| `blocked_permission` | Paused awaiting approval | Amber + badge, allow/deny buttons |
| `failed` | Last run errored | Red, thread readable |

Two blocked flavours are deliberately distinct: a question wants prose, a
permission wants a decision and shows the command. Sending free text to a
permission-paused session does nothing useful (§5.2).

## Where status comes from (§5.3)

- **Detection is immediate, via push.** A question arrives the moment `almadel_ask`
  fires; a permission the moment the hook fires. The plugin POSTs straight away —
  the server is told, not discovering. Sub-second.
- **Telemetry is the backstop, via the poll.** Every claim carries `slot.status`,
  `ticket`, `since`. Up to 35s stale, so it can never drive the badge. Its job is
  reconciliation: the server compares reported state against stored state and
  corrects disagreement (§12.5).

Implementation: the push endpoints (`/ask`, `/permission-request`) and the claim
handler both write `agents.status`; the push wins on latency, the poll wins on
eventual consistency.

## Presence is derived

"Online" is not a column. `GET /api/roster` computes:

```sql
SELECT *, (last_poll >= ?) AS online FROM agents ...
```

with `? = now - LEASE_TTL`. Nothing writes `offline`; the lease sweep just stops
matching fresh `last_poll`. An agent that vanishes has its ticket requeued by the
sweep (§04) and drops to `offline` on the next roster read.

## `needs_you` count

Global (not per-project), by design (§3.3): you want to know an agent is blocked
whether or not you're looking at that project's board.

```sql
SELECT count(*) FROM tickets WHERE state LIKE 'blocked%';
```

Everything else in the roster is scoped to a project: board, columns, prompts,
tickets, comments, branches, slots, join tokens. Only the badge and the sidebar
grouping are global.

## `/api/roster` response shape

```json
{
  "needs_you": 1,
  "projects": [
    {
      "id": "almadel-api",
      "name": "almadel-api",
      "slots": [
        { "id": "agt_abc", "name": "Gediel", "label": "laptop",
          "status": "blocked_question", "ticket": "TCK-418", "online": true }
      ]
    }
  ]
}
```

## Roster SSE

`/api/roster/stream` emits `event: roster` on any presence/status change. The client
re-renders from `/api/roster` (the badge is a query, never a counter, §5.4). The
stream is a change signal, not a state transport.
