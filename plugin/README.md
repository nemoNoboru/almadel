# @almadel/opencode-plugin

Turns an opencode instance into an [Almadel](https://github.com/your-org/almadel) board agent. The worker runs **in-process** as an opencode plugin: it dials out to the Almadel server, long-polls for tickets, and executes them in this opencode session.

## Non-negotiables

- **In-process worker** — no outboard process.
- **Per-ticket git worktrees** — each ticket runs in its own `git worktree` on its own `run/TCK-N` branch under `.almadel/wt/<ticket>` (isolated, never `-f`).
- **Agents dial out** — the server never connects to the agent.
- **All state lives in the ticket** — nothing meaningful persisted locally.
- **Projects are a namespace** — enforced by the claim query and re-verified by the plugin on every job.
- **Plugin tools are the only path** — no curl fallback.
- **TypeScript on Bun** everywhere.
- **Enlistment is per-process, never persisted** — no `.almadel.json`; intent comes from `/almadel join` or the `ALMADEL_JOIN` + `ALMADEL_TOKEN` env pair.
- **NEVER `git checkout -f`** — worktrees are never clobbered.
- **Stage boundaries commit** — a dirty worktree at stage end is a bug, not a feature. Uncommitted work is unreachable from any other machine.

## Enlistment

Two ways to join a board:

### Headless (env)

```sh
ALMADEL_SERVER=http://127.0.0.1:8787 \
ALMADEL_JOIN=almadel-api \
ALMADEL_TOKEN=<token> \
ALMADEL_LABEL=laptop \
opencode serve
```

`ALMADEL_JOIN` is the **project id or name** (resolved against `GET /api/projects`). `ALMADEL_TOKEN` is the registration token. The project is **never** inferred from the git remote.

Set `ALMADEL_VERBOSE=1` (or `true`) to enable per-job dispatch logs (`job: ...`, `dispatched ...`); these are off by default to keep the TUI quiet. Errors and warnings are always logged.

### Interactive (`/almadel join`)

opencode has no command-execution hook, so a slash command cannot run plugin code directly. Instead, the plugin registers three enlistment tools **unconditionally** and exposes `/almadel:join`, `/almadel:status`, `/almadel:leave` as static command templates that point the model at those tools:

- `/almadel:join` → template tells the model to call `almadel_join {server, project, token?, label?}`. The tool re-points the client, registers, stores the token in memory, and starts polling.
- `/almadel:status` → `almadel_status`
- `/almadel:leave` → `almadel_leave` (deregister + requeue held ticket + stop polling)

## Tools exposed to the agent

| Tool | Effect |
|------|--------|
| `almadel_join {server, project, token?, label?}` | Join a board: register, hold token, start polling. |
| `almadel_status` | Report server/project/agent/ticket. |
| `almadel_leave` | Deregister and stop polling (requeues held ticket). |
| `almadel_read` | Read the current ticket + full thread. |
| `almadel_comment {kind, body}` | Post a comment (or plan). Returns immediately. |
| `almadel_move {column, note?}` | Move the ticket to another column (end of stage). |
| `almadel_ask {question}` | Ask a human; blocks up to 5 min for an answer. |

`almadel_move`'s `column` arg is a zod enum built from the project board, so an off-board move is structurally impossible.

## How it works

1. **Register** — `POST /api/agents` upserts the slot on `(project_id, repo_root, label)` and reports `git_remote` (read from `remote.origin.pushurl`/`remote.origin.url`) so the server can refuse a remote mismatch. The agent later uses this remote (via the prompt's `{{remote}}` var) to push its branch and open a PR.
2. **Poll** — long-poll `POST /api/claim` (~35s) with telemetry.
3. **Task** — verify project, prepare (or reclaim) the ticket's worktree on `run/{id}` (reconstructing from `(branch, head_sha)` when the ticket has history), `chdir` into it, create a session, send the server-rendered prompt verbatim. On stage end the worktree is committed and pushed to `run/{id}`, the SHA is recorded on the ticket, then the plugin re-anchors back to the repo root; the worktree + branch stay for review.
4. **Ask** — `POST /api/tickets/{id}/ask` then long-poll `GET /api/questions/{qid}`. Fast path returns the answer; slow path returns "no answer yet" and the answer arrives as a new message.
5. **Permission** — the `event` hook receives `permission.asked`, read-only checks auto-allow, the rest are forwarded to the server via `/permission-request` (which blocks until a human decides).

## Development

```sh
bun install
bun run typecheck
bun test
```
