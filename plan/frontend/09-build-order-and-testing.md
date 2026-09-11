# 09 — Build Order and Testing

The frontend is built in lockstep with the server's Phase 1–5 (`../00-overview.md`,
`vision.md` §15). The frontend's contribution to each phase, with acceptance
criteria.

## Phase 1 — the boring path (board CRUD)

The board exists and a ticket flows through it, no streaming, no blocking.

Frontend work:
- Three-pane shell, board, roster (static), conversation read-only.
- Ticket create; card render; project switcher; column render with prompt/gate
  and WIP indicators.
- Column/pipeline editor (basic: name, prompt, next, wip_limit).
- `/join` page with the two steps.

Acceptance:
- Create a ticket in a prompted column → it appears `ready`.
- A joined agent claims it (server side); the card flips to `running` and shows
  the agent name on the next roster tick/refresh.
- Agent `almadel_move`s → card lands in the next column on the next board
  re-render.
- Column editor: edit a prompt, save, re-render; the gate/prompt distinction is
  legible.

## Phase 2 — visibility (events + live log)

Frontend work:
- Ticket SSE stream + live-log pane (`07-events-and-live-log.md`).
- Roster SSE stream + `needs_you` re-render.
- Cancel control.

Acceptance:
- A `working` ticket's log populates live from pushed, batched, sequenced events.
- Refresh mid-run reproduces the log exactly (replay from `events`).
- Cancel interrupts the run; the card returns to a terminal/ready state and the
  board reflects it.

## Phase 3 — the ask loop (blocking + chat)

The differentiator. Frontend work:
- Amber `blocked_question` / `blocked_permission` states on cards and roster.
- Conversation pane compose box for questions; allow/deny + scope for
  permissions, with the command shown.
- Pending-message (nudge) display for `working`.

Acceptance:
- Agent `almadel_ask`s → amber badge appears sub-second (push path).
- Human replies → answer lands in the thread; the turn resumes; card returns to
  `running`.
- A permission request shows the command; Allow/Deny with scope resolves it and
  resumes the turn.
- The compose box is never shown for `blocked_permission`, and buttons are never
  shown for `blocked_question` (§5.2).

## Phase 4 — multi-project, multi-agent

Frontend work:
- Roster grouping by project, floating blocked agents to the top.
- Join tokens on the `/join` page; pending → green tick over the roster stream.
- Port band surfacing in the column prompt preview.

Acceptance:
- Multiple projects in the roster; the board shows exactly one; switching is
  unambiguous; the conversation pane never leaks another project's ticket.
- The global `needs_you` count spans projects and survives a refresh.
- The `/join` page ticks green the moment a slot registers.

## Phase 5 — packaging

Frontend work:
- Confirm the embedded UI ships in the `bun build --compile` binary (assets and
  templates embedded; no filesystem/asset-path assumptions).
- Confirm HTMX is embedded (no CDN reference) in the self-contained binary.

Acceptance:
- A single binary serves the board with zero external asset fetches.

## Testing

The frontend is server-rendered, so the meaningful unit is the render +
fragment swap. Layered:

1. **Template/unit tests** (Bun test): each partial renders a given domain
   object deterministically — a card for each `state` chip, a roster agent for
   each status, the conversation control for each state (assert the *absence* of
   a text box for `blocked_permission` and of buttons for `blocked_question`).
2. **HTTP integration tests**: each browser-facing route returns 200/400/404 as
   specified in `../03-api-surface.md`; the board fragment for a project excludes
   other projects' tickets (§2.5) — a scoping regression test.
3. **No-JS smoke test**: every mutation has a fallback that works without the
   drag/SSE script (assert the `select`-move form is emitted and POSTs
   correctly).
4. **Replay test**: seed `events` rows, open `/api/tickets/{id}/stream?after=N`,
   assert exactly the missed events come back in order, no dupes.
5. **Manual spike checklist** for the realtime paths: sub-second amber badge on
   `almadel_ask`; log auto-scroll + "jump to latest"; refresh reproduces badge
   count.

## Open frontend decisions (fold into `../`-level open questions)

- **Drag library**: hand-rolled HTML5 DnD is the default; revisit if
  intra-column priority reordering becomes a feature (`01-stack-and-layout.md`).
- **Template engine**: a minimal string/render function vs a tiny template lib —
  settle before Phase 1 so all partials share one idiom.
- **Prompt preview + rendered-prompt storage** (§17.5): the editor previews; the
  decision of whether dispatch stores the rendered prompt is a server concern,
  but the preview UI is built to assume it will.
