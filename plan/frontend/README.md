# Almadel — Frontend Plan

This folder holds the implementation plan for the **embedded board UI** of the
`almadel` server package: the kanban board, the agent roster, the conversation
panel, the column/pipeline editor, and the enlistment (`/join`) page.

It is the frontend half of the server plan in `../` (see `../00-overview.md`).
The plugin (`@almadel/opencode-plugin`) and the server's HTTP/SQLite backend are
out of scope here except where the UI consumes their contract (the
browser-facing API in `../03-api-surface.md`, the SSE endpoints, and the data
model in `../02-data-model.md`).

## What the frontend is

Three panes, one screen (§5.7 of `vision.md`):

```
┌─────────────┬──────────────────────────────────┬──────────────┐
│ almadel-api │  Spec  Planning  Review  Impl    │ Gediel       │
│ ● Alimiel   │  ┌───┐ ┌───┐    ┌───┐   ┌───┐    │ blocked      │
│   working   │  │412│ │418│    │405│   │399│    │ TCK-418      │
│ ▲ Gediel  1 │  └───┘ └───┘    └───┘   └───┘    │──────────────│
│   blocked   │                                  │ agent: which │
│             │                                  │ auth backend?│
│ almadel-web │                                  │              │
│ ○ Barachiel │                                  │ [ reply... ] │
│   idle      │                                  │              │
│─────────────│                                  │              │
│ Needs you 1 │                                  │              │
└─────────────┴──────────────────────────────────┴──────────────┘
   roster            board (selected project)        conversation
```

The left pane is the **roster** — agents grouped by project, with presence and a
global `Needs you` count. The middle pane is the **board** — the kanban for the
currently selected project, where columns are prompts. The right pane is the
**conversation** — a ticket's thread, the compose box, and the allow/deny
controls for a permission-paused agent.

## Design pillars carried from `vision.md`

1. **Column-as-prompt.** The board *is* the workflow. A column with a prompt is
   an agent stage; a column without one (`prompt: null`) is a human gate (§4).
   The UI must make that distinction legible at a glance.
2. **The board is the database.** All state lives in the ticket; the UI renders
   it, never holds it (§2.4). A hard refresh must reproduce the exact screen.
3. **Presence is derived.** An agent is online iff `last_poll` is fresh; nothing
   writes `offline` (§7). The UI never stores presence locally.
4. **Badges come from a query, not an event count** (§5.4). SSE says *something
   changed, re-render*; the truth is `SELECT count(*) FROM tickets WHERE state
   LIKE 'blocked%'`.
5. **Two blocked flavours are distinct.** `blocked_question` wants prose;
   `blocked_permission` wants a decision and shows the command (§5.2). The UI
   never offers a text box to a permission-paused session.
6. **The chat is not a side channel.** Everything said to an agent is a comment
   row on the ticket and will be inlined into the next stage's prompt (§5.6).
   The UI must not imply otherwise.

## Files

| File | Contents |
|------|----------|
| [`01-stack-and-layout.md`](./01-stack-and-layout.md) | Tech stack, embedding, routing, the three-pane shell |
| [`02-board.md`](./02-board.md) | Kanban columns, cards, drag semantics, WIP limits |
| [`03-roster.md`](./03-roster.md) | Agent roster, presence, status model, `needs_you` |
| [`04-conversation.md`](./04-conversation.md) | Thread view, compose, permission controls, cancel/takeover |
| [`05-columns-editor.md`](./05-columns-editor.md) | Pipeline editor: prompts, WIP limits, reorder, next/fail |
| [`06-join-page.md`](./06-join-page.md) | The `/join` enlistment page |
| [`07-events-and-live-log.md`](./07-events-and-live-log.md) | SSE wiring, replay, live log pane |
| [`08-state-and-interactions.md`](./08-state-and-interactions.md) | Optimistic UI, re-render strategy, error handling |
| [`09-build-order-and-testing.md`](./09-build-order-and-testing.md) | Phase 1–5 mapping, acceptance criteria, testing |

## Source of truth

Everything below is derived from `../../vision.md` (section references point
back into it) and reconciles against `../03-api-surface.md` (the browser-facing
endpoints) and `../02-data-model.md` (the schema the UI reads). Where the
frontend needs a decision the vision doesn't make — e.g. the JS approach for
drag-and-drop — it is called out explicitly under "Decision".
