# 06 — Event push

The plugin pushes; the server never pulls (§8). The `event` hook receives
session events and forwards a filtered, batched, sequenced stream to
`POST /api/tickets/{id}/events`. The server fans out to browsers over SSE.

## Filter (§8)

Forward only: assistant text, tool calls and results, permission requests,
session idle, errors. **Nothing else.** This is deliberate — the log is not a
firehose of every internal opencode event.

## Batch (§8)

Batch every ~250ms or ~4KB, **but permission, error, and idle flush
immediately** — those are exactly the events that need to be fast (an amber badge
on a blocked agent must not wait for a buffer to fill).

## Buffer (§8)

On failure, buffer and keep going. The run matters; log display doesn't. A push
failure must never interrupt the session — catch, queue, retry on the next
interval.

## Sequence per ticket (§8)

Each ticket's events carry a `seq`, so a reconnecting browser resumes at its
last-seen offset. The plugin maintains the sequence for the ticket it's running;
the server's `events` table is the source of truth for replay.

## Flush rules summary

| Event | Flush |
|-------|-------|
| assistant text | batched |
| tool call | batched |
| tool result | batched |
| permission request | **immediate** |
| session idle | **immediate** |
| error | **immediate** |

## The event hook must not block the session

`onEvent(agent)` is synchronous-from-the-session's-view: it enqueues into a
buffer and returns. The actual HTTP push happens on a timer / microtask, so a
slow or dead server degrades log display, not the agent's work. This mirrors the
"buffer on failure and keep going" rule and is the plugin-side version of "the
run matters."

## Status vs events

Status (roster sidebar, §5.3) has two sources: **push** (a question or permission
fires → the plugin POSTs immediately, sub-second) and **telemetry via poll** (up
to 35s stale, reconciliation only). The event push feeds the live-log/SSE fan-out;
the telemetry in each claim feeds the roster's backstop. They are separate
payloads and should stay separate in the code.
