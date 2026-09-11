# 06 — Blocking, Ask, Permissions

Phase 3. The differentiator. Two things stop an agent, and only one involves the
agent cooperating (§12.1):

| | Question | Permission |
|---|---|---|
| Cause | Agent chose to ask | opencode paused awaiting approval |
| Almadel learns via | `almadel_ask` tool call | plugin's permission hook fires |
| Agent cooperated? | Yes | No — it doesn't know |
| Answer is | Free text | allow / deny + scope |
| Delivered by | Resolving the pending tool call | Resolving the hook in-process |
| UI | Compose box | Buttons + the command shown |

**The server owns the decision; the plugin owns the delivery.** The server can
never talk to opencode; it writes to the thread and queues a job. This doc is the
server half.

## The ask loop (server side)

`almadel_ask` (plugin tool) POSTs `/api/tickets/{id}/ask`. The server:

1. Inserts a `questions` row (`deferred=0`), sets `tickets.state='blocked_question'`,
   appends a `comments` row (`kind='question'`, author `agent`), broadcasts `notify`
   + roster stream so the badge flips immediately (push, not poll).
2. The plugin then blocks on `GET /api/questions/{qid}` (long poll) for the answer,
   up to `ASK_TIMEOUT` (5 min).

### Fast path

Human replies via `/api/tickets/{id}/reply` within the window → server writes the
answer into `questions.answer`, appends a `comments` row (`kind='answer'`), sets
`state='running'`, and **resolves the parked long poll on `/api/questions/{qid}`**
with the answer text. The plugin's tool call returns with that answer; the agent
continues mid-turn with full context (§2.7).

### Slow path (deferred)

The `ASK_TIMEOUT` expires with no answer. The plugin calls the deferred marker
(`questions.deferred=1`) and the tool returns an instruction to end the turn. The
ticket stays `blocked_question` with **no pending call to resolve**. When a reply
eventually arrives, the server sees no parked poll on the question id and instead
queues a `reply` job:

```
{ type: "reply", project, ticket, text: <answer> }
```

The plugin receives it on the next claim and injects the answer as a new message
into the still-live session. Context survives because the session does.

**How the server knows which path it's on:** it checks whether a long poll is
parked on the question id. Parked → resolve it (fast); not parked → queue a `reply`
job (slow). §12.5.

### The hybrid, one question row

One `questions` row serves both paths; the `deferred` flag records which one was
taken. The UI is identical either way — you don't know or care which path you're on
when you type the reply. The reply handler branches on the flag.

## The permission flow (server side)

The plugin's permission hook fires (agent did NOT cooperate). The plugin POSTs
`/api/tickets/{id}/permission-request` with `{ tool, command }`. The server:

1. Inserts a `permissions` row (`decision=NULL`), sets
   `tickets.state='blocked_permission'`, appends a `comments` row
   (`kind='permission'`, the command shown in the UI), broadcasts `notify` + roster
   stream.
2. The request **blocks** (long poll on the permission id, in-process on the plugin
   side) until a human decides.

Human clicks allow/deny → `/api/tickets/{id}/permission` `{ decision, scope }`:

```
you click "allow"
  → POST /api/tickets/TCK-412/permission       (browser → server)
  → decision recorded, job queued              (server)
  → { type: "permission", ... }                (server → plugin, next poll)
  → event.effect = "allow"                     (in-process, hook resolves)
  → turn resumes, events flow again
```

Latency is one poll cycle, up to 35s (§12.3). Acceptable against a twenty-minute run.

### Auto-deny

A permission pending with no answer for `PERMISSION_TTL` (1h) is auto-denied so
nothing pends silently forever (§12.5). The sweep lives in the same periodic timer
as lease expiry (`domain/permissions.ts`).

## Reconciliation (§12.5)

Mostly unnecessary now: with tools as the only path, `blocked` means a turn is
genuinely paused inside a tool call or hook — a fact, not an inference. The one
remaining case is the **deferred ask** branch above: the ticket is blocked with no
pending call, so the answer arrives as an injected `reply` job. The server decides
fast-vs-slow by checking for a parked long poll on the question id. There is no
"agent was told to stop and didn't" case left to detect.

## State transitions (summary)

```
running ──ask──▶ blocked_question ──answer──▶ running
running ──permission-request──▶ blocked_permission ──decision──▶ running
blocked_question ──(timeout)──▶ blocked_question (deferred=1)
blocked_permission ──(1h no answer)──▶ auto-deny → running
```

Both blocked states feed the `needs_you` badge via `state LIKE 'blocked%'` (§5.4).

## UI affordances the server must back

- `blocked_question` → compose box (free text) → `/reply`.
- `blocked_permission` → allow/deny + scope buttons → `/permission`.
- `working` → compose queues a `pending_messages` row (nudge) instead of replying.
- `idle`/`offline` → read-only thread.
- Fixed actions: `/cancel`, `/takeover` (mark human-owned, branch stays checked out).

## Pending messages (nudges)

A reply sent while the agent is `working` (not blocked) is not answerable — the
session is mid-turn and can't accept a message. It's stored in `pending_messages`
(`sent_at=NULL`) and delivered as a `reply`-style job when the turn ends
(`sent_at` stamped). UI shows it as queued so the delay isn't a surprise (§5.5).
