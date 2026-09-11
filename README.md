# Almadel

*A kanban board where the columns are prompts, and the agents are opencode
instances that joined by URL.*

Self-hosted control plane for coding agents. You write a ticket, drop it in a
column, and an agent somewhere picks it up, does the work on its own branch,
and moves the card forward. If it gets stuck — or hits a command it isn't
allowed to run — it asks you in a chat panel and waits.

Read [`vision.md`](./vision.md) for the full design and the `plan/` directory
for the incremental build plans.

## Monorepo layout

| Package | Path | What it is |
|---|---|---|
| Server | [`server/`](./server/README.md) | HTTP API, SQLite store, CLI, and the embedded web UI |
| Web UI | [`web/`](./web/README.md) | React + Vite board frontend, served by the server |
| Plugin | [`plugin/`](./plugin/README.md) | opencode plugin that turns an instance into a board agent |
| E2E | [`e2e/`](./e2e) | Full end-to-end harness (real server + plugin + Playwright) |
| Plan | [`plan/`](./plan) | Design docs and build-order notes |

## Quick start

Everything is TypeScript on [Bun](https://bun.sh) (`>= 1.1`).

```sh
# server (API + embedded UI)
cd server && bun install && bun run dev

# web UI in dev (mock mode, no server required)
cd web && bun install && bun run dev
```

The server listens on `http://127.0.0.1:1213` by default and stores state in
`~/.almadel/almadel.db`. See [`server/README.md`](./server/README.md) for the
full configuration surface and [`server/API.md`](./server/API.md) for the API
contract.

To enlist an agent, install the plugin into opencode and run `/almadel join`
(or use the `ALMADEL_JOIN` + `ALMADEL_TOKEN` env pair) — see
[`plugin/README.md`](./plugin/README.md).

## Development

Each package carries its own scripts:

| Package | Typecheck | Test | Notes |
|---|---|---|---|
| `server/` | `bun run typecheck` | `bun test` | `bun run build:ui` bundles the web UI |
| `web/` | `bun run build` | `bun test` | `bun run lint` (oxlint) |
| `plugin/` | `bun run typecheck` | `bun test` | |
| `e2e/` | — | `./run.sh` | local only — needs a real model + opencode |

### Git hooks

Pre-commit hooks keep secrets and junk out of the history. Install them once:

```sh
pip install pre-commit   # or: uvx pre-commit
pre-commit install
```

## License

[MIT](./LICENSE)
