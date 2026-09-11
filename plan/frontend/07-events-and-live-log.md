# 07 — Events and the Live Log

The frontend's realtime behaviour is two SSE streams plus the "query is the
truth" re-render rule. The streams say *something changed*; the DOM is rebuilt
from queries, never accumulated from events.

## Two streams

| Stream | Endpoint | Event | On receive |
|---|---|---|---|
| Roster | `GET /api/roster/stream` | `roster` | re-fetch `/api/roster`, swap roster fragment |
| Ticket | `GET /api/tickets/{id}/stream?after=<seq>` | `tick` | append/update log; re-render thread if a `comment`-class event arrived |

The roster stream is opened once per page. The ticket stream is opened when the
conversation pane pins to a ticket and closed when it is unpinned (one live
ticket at a time).

## SSE conventions (from `../03-api-surface.md`)

- `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
- `: ping` every ~15s to defeat idle-kill proxies.
- Ticket stream: `event: tick`, `data: { seq, kind, payload }`; reconnect with
  `?after=<seq>`.
- Roster stream: `event: roster`, `data: { ... }`; client re-renders from
  `/api/roster` on reconnect.

## Replay and resume

The ticket stream carries a per-ticket `seq` (`PRIMARY KEY (ticket_id, seq)`,
`../02-data-model.md`). The client remembers the last `seq` it saw and reconnects
with `?after=<seq>`, so a dropped connection replays exactly the missed events
and never duplicates. On a fresh open it starts at `seq=0` and the server
replays the whole stored `events` history for that ticket.

This is the live-log durability story: the log is not just in-flight SSE — it is
the `events` table, replayed on open. A hard refresh reproduces the exact log.

## The live log pane (Phase 2)

For a `working` (or `blocked*`) ticket, the conversation pane shows a live log
of the agent's activity: assistant text, tool calls, tool results, permission
requests, session idle, errors (§8 filter set). The log is a running tail, not
the durable thread — the two are visually separated (`04-conversation.md`):

```
┌─ live log ─────────────┐
│ 12:03  tool: run tests │
│ 12:04  result: 3 pass  │
│ 12:05  assistant: ...  │
└────────────────────────┘
┌─ thread ───────────────┐
│ agent  plan: <artifact>│
│ human  answer: ...     │
└────────────────────────┘
```

- Log events render monospace-ish, one line per event, newest at the bottom,
  auto-scrolled unless the user has scrolled up (then a "jump to latest" affordance).
- Events that are also durable comments (e.g. a `move`, a `question`) appear in
  the thread, not the log — the log shows transient activity only.

## Batching and flush are the server's concern

The plugin batches events (~250ms / ~4KB) and flushes permission/error/idle
immediately (§8). The frontend just renders what arrives; it must not assume
event cadence. The live log updates in bursts, and that is correct behaviour.

## Re-render rule (applies to both streams)

No stream event carries enough state to mutate the DOM safely on its own
(§5.4). The rule everywhere:

1. an SSE event arrives,
2. the client re-fetches the relevant query (`/api/roster`, or the ticket
   thread/state),
3. the server renders the fragment,
4. HTMX swaps it in.

The only exception is the live-log append, which is a pure append of already-
sequenced, idempotent `tick` events (replay-safe). Everything else is
query-driven.

## Connection lifecycle

- `EventSource` auto-reconnects; on `error` the client does nothing special
  beyond waiting for reconnect — the streams are lossy hints, and a reconnect
  replays from the last `seq` / re-fetches the roster.
- If SSE is unavailable (proxies blocking it), the UI degrades to polling the
  query endpoints on a slow interval, and the board remains fully usable —
  live updates become laggy, not broken.
