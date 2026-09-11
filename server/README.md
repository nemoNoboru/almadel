# Almadel server

Self-hosted control plane for coding agents — a kanban board where the columns
are prompts and the agents are opencode instances that join by URL.

This is the server package: an HTTP API, a SQLite store, and the embedded web UI.
See `API.md` for the full API contract.

## Requirements

- [Bun](https://bun.sh) `>= 1.1`

## Install

```sh
bun install
```

## Run

```sh
bun run start          # serve (headless if no UI is present)
bun run dev            # serve with --watch
bun run src/cli.ts init   # initialise the database only
```

The server listens on `http://127.0.0.1:1213` by default and stores state in
`~/.almadel/almadel.db`. The embedded UI is served automatically when present.

## Configuration

All settings are read from the environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `ALMADEL_HOST` | `127.0.0.1` | Bind host |
| `ALMADEL_PORT` | `1213` | Bind port |
| `ALMADEL_DB` | `~/.almadel/almadel.db` | SQLite path |
| `ALMADEL_STATIC` | auto | Static UI directory |
| `ALMADEL_POLL_WINDOW` | `35000` | Long-poll window for `/api/claim` (ms) |
| `ALMADEL_LEASE_TTL` | `90000` | Agent "online" freshness threshold (ms) |
| `ALMADEL_SWEEP_INTERVAL` | `15000` | Lease/permission sweep interval (ms) |
| `ALMADEL_ASK_TIMEOUT` | `300000` | `almadel_ask` fast-path window (ms) |
| `ALMADEL_PERMISSION_TTL` | `3600000` | Permission request auto-deny (ms) |
| `ALMADEL_PORT_BASE` | `8000` | Start of the agent port band |
| `ALMADEL_PORT_BAND_WIDTH` | `100` | Width of the port band |
| `ALMADEL_MIN_OPENCODE_VERSION` | `1.0.0` | Minimum opencode version at registration |

## API

Everything lives under `/api`; non-`/api` paths fall through to static file
serving, then `404`. Three audiences, three identity schemes:

- **Browser (human)** — no auth; roster, board, move, reply, permission
  decisions, cancel, takeover, columns.
- **Plugin** — `Authorization: Bearer <token>` from registration; comment, ask,
  question poll.
- **Agent poll loop** — `Bearer <token>` or `X-Almadel-Agent: <agent_id>`;
  claim, events, permission-request.

See [`API.md`](./API.md) for the de-facto endpoint reference.

## Development

```sh
bun run typecheck      # tsc --noEmit
bun test               # bun test
bun run build:ui       # bundle the embedded web UI
```
