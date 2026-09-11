# 08 — State and Interactions

This doc covers the cross-cutting interaction rules: what the UI may optimistically
change, what it must never hold locally, and how failures reconcile.

## The cardinal rule: the board is the database

`vision.md` §2.4 — all state lives in the ticket. The UI renders server state;
it never owns it. Concrete consequences:

- **No client-side store.** There is no board model in the browser; there are
  only server-rendered fragments.
- **A hard refresh is always correct.** The server paints the full truth on
  load; SSE/HTMX only update fragments from that truth.
- **The badge count is never an increment.** It is `SELECT count(...)`
  re-rendered from `/api/roster` (§5.4). A reconnect or refresh cannot lose it.

## What is optimistic, and what is not

Only one interaction is optimistic:

- **Card drag.** The card is placed in the target column immediately (it feels
  like a board), the `POST /api/tickets/{id}/move` fires in parallel, and the
  SSE tick / response reconciles.

Everything else is request-then-swap: reply, permission decision, cancel,
takeover, column edits, ticket creation. They POST, the server mutates, and the
server re-renders the affected fragment (thread, roster, board).

### Reconciling an optimistic move

On success the server's board render is authoritative and the card stays. On
failure (e.g. WIP limit hit, cancelled-while-dragging) the server returns an
error and the client re-fetches the board fragment, snapping the card back. The
optimistic state is always short-lived and always corrected by a re-render.

## Progressive enhancement

- With JS disabled: drag becomes "click a card → choose a target column" (a
  `select`-driven move form), and SSE becomes full-page refresh. Every mutation
  must have a non-JS fallback path.
- With SSE unavailable: the query endpoints are polled on an interval
  (`07-events-and-live-log.md`).

The no-JS path is not a nicety — it is the guarantee that the board *is* the
database and can be operated without the client doing anything clever.

## Error and empty states

| State | Rendering |
|---|---|
| No projects | empty board + "create a project" |
| Project with no agents | roster group shows "no agents joined" + link to `/join` |
| Ticket 404 (deleted elsewhere) | conversation pane clears, board re-renders |
| POST returns 400 (validation) | inline zod issue list next to the offending field |
| POST returns 403 | shown only if a scoping bug exists; surface "out of scope", do not retry |
| SSE disconnected | subtle "reconnecting" dot, never a blocking modal |

## Confirmation rules (destructive actions)

Only three actions are destructive enough to confirm:

1. **Cancel** (interrupts a live agent),
2. **Take over** (changes ownership),
3. **Dragging a `running` card out of its column** (which cancels first, §4.4).

Confirmations are inline (an "are you sure" expands in place), not `window.confirm`
dialogs — they must work and be legible in the HTMX/no-JS world.

## Focus and keyboard

- Tab order: roster → board → conversation, left to right.
- A card is keyboard-focusable; Enter selects it (opens the conversation);
  the move form is reachable by keyboard.
- The compose box autofocuses when a `blocked_question` ticket is selected —
  the single highest-value keystroke in the product is answering a blocked agent.

## Accessibility notes carried forward

- Blocked states are communicated by colour **and** a text badge ("needs
  answer", "needs decision"), never colour alone (§5.2's amber).
- Presence dots have a text label (`online`/`offline`) alongside the dot.
- Live-log auto-scroll respects `prefers-reduced-motion` and a manual scroll
  position.
