# 02 — The Board

The board renders one project's columns and their tickets. It is the primary
surface and the embodiment of "column-as-prompt" (§4): moving a card is running
it. There is no run button.

## Columns

A column is a small config object (§4.1) rendered as a vertical strip:

```
┌─────────────┐
│ Implement   │   name; prompted-column badge (● auto) or gate (— manual)
│ 2 / 2  FULL │   WIP usage
│─────────────│
│ ┌─────────┐ │
│ │ TCK-412 │ │   card: title, id, state chip
│ └─────────┘ │
│ ┌─────────┐ │
│ │ TCK-418 │ │   blocked → amber chip
│ └─────────┘ │
└─────────────┘
```

### The prompt/gate distinction

- **Prompted column** (`prompt != null`): shows a small "auto" indicator — a
  card dropped here is dispatched to an agent (§4.4). Its header links to the
  column editor (`05-columns-editor.md`) so the prompt is one click away.
- **Human gate** (`prompt == null`): shows a "manual" indicator. Nothing
  auto-dispatches; the column is where a human reads an artifact before moving
  the card on by hand.

### WIP limit

`wip_limit` renders as `n / limit`. At `n >= limit` the column header shows
"FULL" and the drop target is disabled (the server also rejects — the UI just
reflects the truth before the round-trip). `wip_limit` is null for gates and
terminal columns.

### Terminal columns

`Done` and `Failed` have no `next_column` and nothing dispatches from them
(§2 of the data-model seed). They render without a drop affordance for "next"
and accept drops as a final resting place.

## Cards

A card is one `tickets` row. It shows:

- the ticket id (`TCK-412`) and title,
- a **state chip** derived from `state`:
  - `ready` — neutral, waiting to be claimed,
  - `running` — active (agent working),
  - `blocked_question` / `blocked_permission` — amber, links to the conversation,
  - `done` / `failed` — terminal tint,
- the holding agent's name when `agent_id` is set and state is `running`/`blocked*`,
- the branch name when set (`run/TCK-412`), shown subtle, as a review hint.

Cards are sorted server-side by `priority DESC, created_at ASC` (the claim
order). The UI does not reorder cards.

## Drag semantics (§4.4)

The only bespoke JS on the page implements column-to-column moves:

- Dragging a `ready`/`done`/`failed` card into a **prompted** column sets it
  `ready` and broadcasts on `notify`. This is `POST /api/tickets/{id}/move`
  with the target column.
- Dragging a `running`/`blocked*` card out of its column **cancels it first**
  (`POST /api/tickets/{id}/cancel`), then moves it. The UI confirms this because
  it interrupts a live agent — the cancel is destructive, so it is not silent.
- There is no "run" button anywhere. Move = run.

The move is an optimistic swap: the card is placed immediately, then reconciled
when the SSE tick (or the POST response) confirms. On failure the server's
authoritative board re-renders (see `08-state-and-interactions.md`).

## Creating a ticket

A "new card" affordance per column (or a single "+" at the board header) opens
an inline form: title, body, target column. Creating a ticket in a prompted
column immediately marks it `ready` and broadcasts on `notify` (§11.1) — the
server does the notify; the form just POSTs the ticket.

## Board scope and the project switcher

The board shows one project. The project switcher lives in the header (fed by
`/api/roster`). Switching projects replaces the board fragment and — if the
conversation pane is pinned to a ticket from the old project — clears it, since
the roster/board/conversation must never show another project's ticket (§3.3,
§5.7).

## Card details

Clicking a card (not dragging it) selects it: it highlights on the board and the
conversation pane opens to that ticket's thread (`04-conversation.md`). Card
selection and agent selection are the same pane, keyed by ticket — one thread,
two views (§5.6).
