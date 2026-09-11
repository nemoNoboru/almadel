# Almadel — Web UI

The board frontend for [Almadel](../../vision.md). A React + TypeScript SPA built
with Vite and [shadcn/ui](https://ui.shadcn.com), designed to be **served
alongside the almadel server** (it is not the opencode plugin).

> Note: the original plan pinned the UI to HTMX + SSE with plain CSS
> (`plan/frontend/`). This package deliberately forks that decision to use
> shadcn (React + Tailwind). The *data contract* is unchanged — it consumes the
> same browser-facing API (`plan/03-api-surface.md`) and follows the same
> "the board is the database, the query is the truth" re-render rules.

## Stack

| Concern | Choice |
|---|---|
| Framework | Vite + React 19 + TypeScript |
| UI | shadcn/ui (radix + Tailwind v4) |
| Routing | `react-router` (`/p/:projectId`, `/join`) |
| Realtime | SSE (`/api/roster/stream`, `/api/tickets/{id}/stream`) with query re-fetch |
| Data | Typed API client (`src/api/`) + in-memory **mock mode** until the server lands |

## Run

```bash
bun install
bun run dev        # mock mode — no server required
bun run build      # typecheck + production build to dist/
bun run lint       # oxlint
bun test           # unit + component tests (Bun's test runner)
bun run test:coverage   # tests + coverage report
```

### Mock mode vs. real server

By default the app runs against the in-memory mock (`src/api/mock/`) so the
whole board — roster, kanban, conversation, join page, and a simulated
permission event a few seconds in — is fully demoable with no backend.

To talk to a running almadel server instead:

```bash
VITE_ALMADEL_MOCK=0 ALMADEL_SERVER_URL=http://localhost:1213 bun run dev
```

In dev, Vite proxies `/api` to `ALMADEL_SERVER_URL`. In production the server
serves `dist/` directly, so the API and assets share one origin.

## Layout

```
web/src/
├── api/            # AlmadelClient interface, HTTP client, mock data layer
├── state/          # AppProvider — roster/board/thread state + live re-fetch
├── types/          # domain types (mirror of plan/02-data-model.md)
├── lib/            # cn(), display helpers (state labels, relative time)
├── components/
│   ├── ui/         # generated shadcn components
│   ├── layout/     # Header (project switcher, "needs you" badge)
│   ├── roster/     # agent roster grouped by project, presence + status
│   ├── board/      # kanban columns, cards, drag-to-move, pipeline editor
│   └── conversation/ # thread view, compose, permission allow/deny
└── pages/          # BoardPage (three panes), JoinPage (enlistment)
```

## Design pillars carried from `vision.md`

- **Column-as-prompt** — a prompted column is visibly an agent stage ("auto");
  an empty prompt is a human gate ("manual").
- **The board is the database** — no client store owns the board; every mutation
  re-fetches the authoritative query.
- **Presence is derived** — an agent is online iff its `last_poll` is fresh;
  nothing writes `offline`.
- **Badges come from a query** — the `needs you` count is `SELECT count(*) …`,
  never an event increment.
- **Two blocked flavours are distinct** — `blocked_question` shows a compose box;
  `blocked_permission` shows the command + allow/deny (never a text box).

## Testing

Tests use **Bun's test runner** with `happy-dom` + `@testing-library/react`.

- `test/dom.ts` registers the DOM globals before anything imports
  `@testing-library/react` (which binds `screen` to `document.body` at module
  load time); `test/setup.ts` wires jest-dom matchers and cleanup.
- `test/utils.tsx` provides fixtures (`makeState`, `makeThread`, …) and a
  `renderWithApp` helper that injects a controlled `AppContext`.
- Logic is covered directly (`store`, `display`, `mock client`, `http`), and
  components are rendered through the controlled context; `app-provider.test.tsx`
  exercises the real provider against the mock client end-to-end.

Coverage target is ≥ 80% (lines and functions):

```bash
bun run test:coverage
```
