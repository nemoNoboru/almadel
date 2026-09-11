# 01 — Stack and Layout

## Tech stack

`vision.md` §6 pins the frontend to **HTMX + SSE**, embedded in the server
package. The server already plans `Bun.serve` with no framework and a thin
router (`../01-architecture.md`). The UI is server-rendered HTML fragments that
HTMX swaps in, plus a small vanilla-JS layer for the one thing HTMX cannot do:
drag-and-drop.

| Concern | Choice | Notes |
|---|---|---|
| Rendering | Server-rendered HTML + HTMX | No SPA; the board is a template, not a client store |
| Realtime | SSE (`EventSource`) | two streams: roster + per-ticket (see `07-events-and-live-log.md`) |
| Interactions | HTMX attributes (`hx-post`, `hx-get`, `hx-swap`, `hx-trigger`) | forms, buttons, reply, move |
| Drag-and-drop | HTML5 DnD API + a thin `<script>` | the only bespoke JS on the page |
| Styling | Plain CSS, a single embedded stylesheet | no CSS framework; keep it self-contained |
| Templates | `src/ui/` partials rendered by the server | one partial per pane/state, re-rendered on SSE |

### Decision: drag-and-drop library

HTML5 native drag-and-drop is enough for horizontal column-to-column moves
(no reordering *within* a column is required by §4 — priority ordering is
server-side). **Recommendation: hand-rolled HTML5 DnD (~40 lines), no
dependency.** A library (SortableJS) is acceptable later if intra-column
reordering for priority becomes a feature, but is not needed for Phase 1.

## Embedding and routing

The UI lives in `src/ui/` of the server package. Templates are rendered with a
server-side function that has direct access to the zod-typed domain objects —
no API round-trip for the initial page load.

```
src/ui/
├── layout.html            # the three-pane shell, shared head, SSE bootstrap
├── board/
│   ├── board.html         # column list + cards for the selected project
│   ├── column.html        # one column (header: name, prompt badge, WIP; body: cards)
│   └── card.html          # one ticket card
├── roster/
│   ├── roster.html        # projects → agents, grouped
│   └── agent.html         # one agent row (presence dot, name, status)
├── conversation/
│   ├── thread.html        # comment/event stream for a ticket
│   ├── compose.html       # reply box / permission buttons, state-dependent
│   └── log.html           # live event log pane (Phase 2)
├── editor/
│   └── column-form.html   # column/prompt/WIP editor form
└── join/
    └── join.html          # enlistment page
```

Routes (browser-facing, from `../03-api-surface.md`):

| Path | Purpose | Rendered from |
|---|---|---|
| `GET /p/{project}` | Board page (full document) | `layout.html` + `board.html` + `roster.html` |
| `GET /join` | Enlistment page | `join/join.html` |
| `GET /api/roster` | Roster fragment (JSON or HTML) | roster partial |
| `GET /api/roster/stream` | SSE: presence/status changes | — |
| `GET /api/tickets/{id}/stream` | SSE: ticket events, replay from `?after=<seq>` | — |

The board page is the only "document" route; everything else swaps fragments
into it. `/api/roster` returns JSON for the initial paint and is re-rendered
server-side into HTML fragments on SSE ticks.

## The three-pane shell

```
<header>  project switcher | Needs you badge | settings                          </header>
<main class="panes">
  <aside id="roster">        ... projects → agents ...   </aside>
  <section id="board">       ... columns → cards ...     </section>
  <aside id="conversation">  ... thread | compose ...    </aside>
</main>
```

- The **roster** is always visible and spans all projects (§3.3: the `Needs you`
  count is deliberately global).
- The **board** shows exactly one project; the roster is how you switch.
- The **conversation** pane is empty until you click an agent or a card; it then
  pins to that ticket until you close it or select another.

### Layout behaviour

- Three columns, fixed proportions (roster ~20%, board ~50%, conversation ~30%).
- The conversation pane is collapsible on narrow screens; the board reflows to
  fill. A mobile experience is not a Phase 1 goal (self-hosted, desktop-first),
  but the panes must not break at 1280px.
- Board columns scroll horizontally if they exceed the pane width; the roster and
  conversation scroll vertically.

## Shared head and SSE bootstrap

One `<head>` is emitted by `layout.html`:

- the embedded stylesheet,
- the HTMX library (embedded, not CDN — self-hosted, single-tenant, no outbound
  requests; see §2.3),
- a small `app.js` that opens the roster SSE stream once and the ticket SSE
  stream on conversation open (see `07-events-and-live-log.md`).

The page must render correctly with JS disabled *for everything except*
drag-and-drop and live updates — HTMX degrades to full-page reloads, and the
initial paint is always a complete server render.

## Accessibility and legibility (board-as-workflow)

The whole point of §4 is that the board *is* the pipeline definition. So the
UI must make three things legible without clicking:

1. **Which columns are agent stages vs human gates** — a prompted column is
   visibly "active" (it will dispatch); a `prompt: null` column is visibly a
   gate.
2. **WIP state** — a column shows `n / wip_limit`; at the limit it reads "full"
   and rejects a drop (server enforces; UI shows it).
3. **Blocked cards** — an amber card for `blocked_question` /
   `blocked_permission`, so a stuck ticket is visible from the board, not only
   from the roster.
