# Alimiel — The Almadel Supervisor

## 1. What this is

Alimiel is a **new, out-of-process supervisor** written in Rust. It replaces the
git/branch/dispatch half of the opencode plugin with a long-lived process that
polls the Almadel server, runs each ticket in a throwaway checkout, commits the
result, and moves the card forward (or flags it for a human). The name is
cosmetic; the crate and binary are both `alimiel`.

It implements [issue #18](https://github.com/nemoNoboru/almadel/issues/18):

> *"It would be a much better implementation if we have an almadel-supervisor …
> that runs in its own process, polling the almadel server."*

## 2. Why

The current plugin runs **inside** opencode and is responsible for four things
that are fragile precisely because they live in-process:

1. Create a new worktree per ticket.
2. Actually `chdir` into it (or the agent silently works in the wrong directory).
3. Ensure work is committed before the ticket moves to Done.
4. Delete the worktree.

That logic is "flaky at best" (issue #18). Moving it out of opencode means:

- opencode no longer needs **any** git or almadel tooling. It is invoked as a
  plain, non-interactive subprocess: `opencode run "<prompt>"` in a clean cwd.
- The supervisor owns all lifecycle: clone, branch, run, commit, push, move,
  cleanup.
- The future path to **ephemeral workers** (containers, k8s pods, GitHub Actions)
  becomes a thin executor abstraction instead of a rewrite (see §17).

## 3. Scope and boundaries

In scope:

- A Rust binary `alimiel` with a long-poll claim loop against the Almadel server.
- Per-ticket: clone, deterministic branch, run opencode non-interactively,
  commit, push, move to the next column — or, on failure, commit, push, comment,
  move to the fail column.
- Cleanup of the throwaway checkout.
- Deterministic commit identity and branch handling identical to the plugin's.

Out of scope (deferred):

- Ask/permission loops. A single-shot `opencode run` cannot hold a permission
  open for a human (§11). This is the known end-state gap and is tracked in §16.
- Reply / permission / cancel / message job delivery (§8.3).
- Worker orchestration beyond "one process, one task at a time" (§17).
- Changes to the server. Alimiel is a *client* of the existing contract
  (`server/API.md`). The server-hosted secrets endpoint in §18 is the one
  exception — a new, future server capability, not part of Alimiel v1.

## 4. The supervisor's role in one picture

```
            ┌──────────────── almadel server (TS/Bun, SQLite) ───────────────┐
            │  POST /api/agents      (register, get token)                    │
  loop ───▶ │  POST /api/claim      (long poll)          ◀─── task job        │
            │  GET  /api/projects/{id}/columns  (resolve next/fail columns)   │
            │  POST /api/tickets/{id}/move     (next / fail)                  │
            │  POST /api/tickets/{id}/comment  (error report)                 │
            └────────────────────────────────────────────────────────────────┘
                                   ▲
                                   │ HTTP (Bearer token)
                        ┌──────────┴──────────┐
                        │  alimiel (Rust)      │
                        │   - poll loop        │
                        │   - git: clone/commit│
                        │   - runner: opencode │
                        │   - columns: next/fail│
                        └──────────┬──────────┘
                                   │ spawn, capture exit code
                        ┌──────────▼──────────┐
                        │  opencode (subprocess) │
                        │  runs the rendered    │
                        │  column prompt, in a  │
                        │  clean ephemeral dir  │
                        └──────────────────────┘
```

Alimiel is the **only** thing that talks to the server and to git. opencode is
launched once per ticket, headless, and its exit code decides the outcome.

## 5. Server API surface Alimiel uses

From `server/API.md` (the de-facto contract) and `server/src/types.ts`:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/projects` | Resolve project id, `git_remote`, `default_branch` |
| `POST /api/agents` | Register; returns `{ agent_id, name, token, port_base }` |
| `POST /api/claim` | Long-poll for the next job (up to ~35s, `204` on timeout) |
| `GET /api/projects/{id}/columns` (or `/board`) | Column list + `next_column` / `fail_column` names |
| `POST /api/tickets/{id}/move` | Move to next/fail column; releases the agent |
| `POST /api/tickets/{id}/comment` | Post the error report on the failure path |
| `POST /api/projects/{id}/git-credential` *(future)* | Mint a short-lived PAT/SSH credential for clone/push (§18.1) |

The claim body is `{ project, agent, slot?: { status, ticket?, since? } }`.
Alimiel sends `slot.status = "idle"` (or `"working"` mid-task, §8.2).

The `task` job shape:

```json
{ "type": "task", "project": "almadel-api", "ticket": "TCK-436",
  "prompt": "<rendered>", "branch": "run/TCK-436",
  "model": "provider/model", "base_sha": null }
```

Two facts the supervisor leans on (verified in `server/src/domain/claim.ts`):

1. **The branch is already deterministic.** `claimNow` sets
   `branch = run/<ticket-id>` and returns it in the job. Alimiel uses
   `job.branch` verbatim — it never invents one.
2. **The prompt is already rendered.** `makeTaskJob` renders the column
   template with `{{ticket.*}}`, `{{thread}}`, `{{branch}}`, `{{project}}`,
   `{{base_sha}}`, `{{remote}}`, `{{port_base}}`. Alimiel passes `job.prompt`
   verbatim — it never re-renders.

## 6. Crate layout (Rust)

A new top-level directory `supervisor/` (crate/binary name `alimiel`), kept out
of the existing Bun workspaces. It is a sibling of `server/`, `plugin/`, `web/`,
`e2e/`.

```
supervisor/
├── Cargo.toml
├── README.md
├── src/
│   ├── main.rs        # entry: config → register → poll loop
│   ├── config.rs      # env/CLI config
│   ├── client.rs      # typed HTTP client for the Almadel API (holds token)
│   ├── agent.rs       # project resolution + registration
│   ├── poll.rs        # long-poll claim loop
│   ├── job.rs         # task lifecycle: run → commit → move / fail
│   ├── git.rs         # clone, checkout branch, commit, push, cleanup
│   ├── runner.rs      # opencode subprocess + exit-code capture
│   └── columns.rs     # next_column / fail_column resolution
└── tests/
    ├── client.rs      # HTTP client against a recorded/plain server
    └── git.rs         # git operations in a temp repo
```

Dependencies (deliberately small):

- `tokio` (async runtime; long-poll fits its timer/IO model)
- `reqwest` (HTTP client, `json` feature) — or `hyper` if we want zero TLS
  dependencies and are fine with more boilerplate
- `serde` + `serde_json` (the wire types)
- `clap` (CLI flags) + environment via `std::env`
- `tracing` + `tracing-subscriber` (structured logs)
- `anyhow` / `thiserror` (error handling)

Git and opencode are invoked as **subprocesses** (`tokio::process::Command`) —
the same pragmatic choice the plugin makes (`plugin/src/git.ts` spawns `git`).
Using `git2`/`libgit2` bindings is noted as an alternative but not required for
v1; shelling out keeps the dependency graph small and matches the plugin's
behaviour exactly.

## 7. Configuration

Resolved from the environment (with CLI overrides):

| Var | Default | Meaning |
|-----|---------|---------|
| `ALMADEL_SERVER` / `--server` | *(required)* | Almadel server base URL |
| `ALMADEL_PROJECT` / `--project` | *(required)* | Project name or id |
| `ALMADEL_LABEL` / `--label` | `hostname` | Upsert key + commit identity suffix |
| `ALMADEL_WORKSPACE` / `--workspace` | `~/.alimiel/` | Base dir for ephemeral clones |
| `OPENCODE_BIN` / `--opencode` | `opencode` | opencode binary path |
| `OPENCODE_ARGS` / `--opencode-args` | *(see §11)* | Extra flags passed to `opencode run` |
| `ALMADEL_VERBOSE` | `false` | Debug logging |

The project identity is **never inferred from a git remote** (same rule as the
plugin's `config.ts`). Alimiel reads `git_remote` and `default_branch` from
`GET /api/projects` after resolving the project id.

## 8. The main loop

### 8.1 Registration

1. `GET /api/projects` → resolve `project` (by id or name) → capture
   `git_remote`, `default_branch`.
2. `POST /api/agents` with:

```json
{ "project": "almadel-api",
  "repo_root": "<workspace>/<project>",
  "git_remote": "<project's remote>",
  "default_branch": "main",
  "label": "<label>",
  "opencode_version": "<detected>",
  "capabilities": { "tools": true, "permission_hook": false } }
```

   `capabilities.tools` must be `true` or the server rejects with `409`
   (`server/src/config.ts` gate). `repo_root` is a deterministic path (the
   workspace), so re-registration upserts the same slot row across restarts
   rather than leaving ghosts.
3. Keep the returned `token` in memory. It is the `Authorization: Bearer` header
   on every agent-facing call. **Never log it, never write it to disk.**

### 8.2 Poll loop

```
loop {
  job = POST /api/claim { project, agent: agent_id, slot: { status } }
  match job {
    None(204)            → continue            // poll window timed out
    task                 → run_task(job)       // §9
    reply|permission|cancel|message → log + ignore   // §8.3
  }
}
```

`status` is `"idle"` before a task and while idle; Alimiel sets it to
`"working"` once it holds a ticket and back to `"idle"` after a move. The server
already gates double-claims on `held?.status !== "idle"` (`claimNow`), and
`moveTicket` releases the agent back to idle, so a sequential supervisor is
naturally well-behaved.

### 8.3 Non-task jobs (v1: ignore)

`reply`, `permission`, `cancel`, and `message` jobs arrive on the same claim
channel. A single-shot opencode run cannot receive them (there is no live
session to inject into, and no parked permission/ask to resolve). v1 logs them
and continues; if a `cancel` arrives for the ticket currently being processed,
Alimiel best-effort kills the opencode subprocess. Real handling requires the
serve-mode path (§16).

## 9. Task lifecycle (the core)

For a `task` job `{ project, ticket, prompt, branch, model, base_sha }`:

```
1. workdir = "<workspace>/<ticket>"          // unique per ticket
2. git clone --no-checkout <remote> <workdir>
   git -C <workdir> fetch origin <default_branch>
   git -C <workdir> checkout <default_branch>
   git -C <workdir> pull
   git -C <workdir> checkout -b <branch>     // deterministic, from job.branch
   (if base_sha set: reconstruct from origin/<branch> if it exists — §10)
3. run opencode (cwd = workdir), capture stdout/stderr + exit code          // §11
4. if exit code == 0:
     sha = commit_all(workdir, ticket, column)      // no-op if clean
     push(workdir, origin, branch)                  // if remote present
     next = resolve_next_column(ticket)             // §12
     POST /api/tickets/{ticket}/move { column: next, note, head_sha: sha }
   else:
     commit_all(workdir, ticket, column)            // best-effort
     push(workdir, origin, branch)                  // best-effort
     POST /api/tickets/{ticket}/comment { kind: "comment",
           body: "alimiel: opencode exited <N>. tail:\n<stderr>" }
     fail = resolve_fail_column(ticket)             // §12
     POST /api/tickets/{ticket}/move { column: fail }
5. cleanup: rm -rf <workdir>                        // best-effort
```

The move **releases the agent** on the server (`moveTicket` → `releaseAgent`),
so the next claim is free to pull the next ticket.

Ordering mirrors the plugin's `almadel_move`: **commit → push → move**, so a
ticket's work is reachable before the server can hand the next stage to another
agent (`plugin/src/tools.ts` lines 163–194).

## 10. Git strategy

- **Fresh clone per ticket** (issue #18's model), under `<workspace>/<ticket>`.
  Simple and crash-safe: a dead supervisor leaves at most one dirty directory,
  never a poisoned shared checkout.
- **Branch from the default branch**, never from a possibly-dirty primary
  checkout. Alimiel has no primary checkout at all — this is the failure the
  issue #18 is about — so the whole class of "dirty worktree, operation not
  allowed" errors disappears by construction.
- **`base_sha` handling.** If the job carries a `base_sha`, the ticket has prior
  history. Reconstruct via `git fetch origin <branch>` and
  `git checkout -b <branch> origin/<branch>` (like the plugin's
  `prepareTicketWorktree`). If the branch is unreachable and `base_sha` is set,
  **fail the ticket** rather than silently restart from the default branch and
  redo work.
- **Never `git checkout -f`.** There is no other agent's work to clobber, but
  the rule still holds: don't force-discard; fail loudly instead.
- **Deterministic commit identity** (same as the plugin):

```
git -c user.name="almadel[<label>]" \
    -c user.email="agent@almadel.local" \
    commit -m "[<ticket>] <column>\n\n<note>"
```

- **Push is required before cleanup.** A fresh clone is deleted at step 5, so
  without a push the commit is lost. Push auth is a short-lived credential
  minted by the server per task (§18.1), never a long-lived key on the worker.

## 11. opencode invocation and permissions

The supervisor runs, from `workdir`:

```
opencode run [<model-flag>] [<permission-flag>] "<job.prompt>"
```

- The `model` from the job (`"provider/model"`) is passed through when present.
- Exit code 0 ⇒ success path; non-zero ⇒ failure path (§9).

**Permissions are the known hard part.** The plugin's spike
(`plan/plugin/09-spike-results.md`) established that `opencode run` **does not
hold permissions open** — it auto-rejects (or auto-allows with `--auto`) on its
own event loop. For v1 the supervisor must pick a non-interactive stance:

- **Recommended v1:** run with a permission config that pre-approves the routine
  set (test/lint/build/`git add`/`commit`, package installs, in-repo
  read/write) and run `opencode run --auto` so anything outside that set is
  auto-allowed rather than silently auto-rejected. This is *not* secure, but it
  unblocks the happy path; a human still reviews the branch/PR.
- **End state (future):** run `opencode serve` and drive a session over its
  client (the plugin's `promptAsync` path), so a permission/ask can stay pending
  until a human answers in the Almadel dashboard. This is what restores parity
  with the in-process plugin's ask/permission loop, and is tracked in §16.

The exact `opencode run` flag surface (`--auto`, `--yolo`, model flag,
exit-code semantics on session error vs idle) must be verified against the
installed opencode version during Phase 2 — this is a spike, not an assumption.

## 12. Column resolution (next / fail)

`server/src/types.ts`: each column carries `next_column` and `fail_column`, which
**reference column names** (`server/API.md`). Alimiel does not hardcode column
ids:

1. `GET /api/projects/{id}/columns` (or `/board`) → the ordered column list.
2. Build a `name → id` map.
3. For the current ticket, read its column and resolve:
   - success → the column named by `next_column` (if absent, treat as terminal —
     the ticket is effectively Done).
   - failure → the column named by `fail_column` (fall back to the current
     column; a `Failed`-named column makes the server set `state = "failed"` via
     `targetStateFor`).

Columns are re-fetched per task (cheap, and they can be edited in the UI between
tickets without a restart).

## 13. Failure matrix

| Failure | Detection | Alimiel response |
|---------|-----------|------------------|
| Unknown project | `GET /api/projects` | Fatal at startup; clear error |
| Registration refused (remote mismatch / missing tools) | `409` from `POST /api/agents` | Fatal at startup; print server message |
| Claim fails (server down) | HTTP error | Retry with backoff; keep the registration |
| Clone fails | git non-zero exit | Comment the error, move to fail column |
| Branch unreachable with `base_sha` | git `rev-parse` fails | Fail ticket — never restart from default |
| opencode exits non-zero | exit code | Commit + push + comment + move to fail (§9) |
| Commit fails | git non-zero exit | Comment + move to fail (do not claim a "clean" move) |
| Push fails | git non-zero exit | Comment the push error; **do not** move forward |
| Move fails (WIP limit, 409) | HTTP error | Comment + retry with backoff; the commit is safe |
| Cleanup fails | `rm -rf` error | Log only; next run names a fresh dir anyway |
| Supervisor crash mid-task | process death | Server lease expiry requeues; fresh clone model makes re-claim idempotent |

Key invariant carried over from the plugin: **a failed commit/push must never
become a successful move.** Commit/push first, move only after both succeed.

## 14. Testing

- **Unit** (`cargo test`): column name→id resolution; commit message formatting;
  job parsing (task vs non-task); config resolution and defaulting.
- **Integration**: spin up the real `almadel` server against a temp SQLite DB,
  point Alimiel at it with a local git repo as `git_remote`, and assert the
  end-to-end path: ticket in Spec → claim → clone → branch `run/TCK-xxx` →
  (fake opencode script that touches a file and exits 0) → commit → move to next
  column; then a ticket with a failing script → comment + move to fail column.
- **openCode invocation** is exercised with a stub binary on `OPENCODE_BIN` so
  tests are deterministic and don't need a model.

## 15. Build order

| Phase | Deliverable | Acceptance |
|-------|-------------|------------|
| 0 | Cargo scaffold, config, logging | `cargo build` clean; `--help` works |
| 1 | HTTP client + registration + claim loop | Claims and logs a `task` job against a live server |
| 2 | git clone/branch + opencode spawn + exit-code capture + commit + push | A fake opencode run produces a committed, pushed branch |
| 3 | Column resolution + move (success/fail) + comment | Ticket flows Spec → next; failing ticket lands in fail column with a comment |
| 4 | Cleanup, `base_sha` re-claim, graceful shutdown, tests | Crash/requeue is idempotent; `cargo test` green |
| 5 | Executor abstraction + docs | A `Worker` trait/interface isolates "run opencode in a dir" so containers/k8s/gh-actions can slot in (§17) |

### 15.1 Subtask tickets

The work is split into the following Almadel tickets (all created in the Spec column on
`almadel-api`), in dependency order:

| Ticket | Phase | Title |
|--------|-------|-------|
| TCK-438 | 0 | Rust scaffold, config, logging |
| TCK-439 | 1 | HTTP client, registration, claim loop |
| TCK-440 | 2 | Git clone/branch + opencode runner + commit/push |
| TCK-441 | 3 | Column resolution, move, comment |
| TCK-442 | 4 | Cleanup, base_sha re-claim, graceful shutdown, tests |
| TCK-443 | 5 | Executor abstraction + docs |
| TCK-444 | §18.1 | Server git-credential ephemeral token endpoint (future) |
| TCK-445 | §18.2 | Server LiteLLM-compatible LLM proxy (future) |

Phases 0–5 are the Alimiel v1 Rust build and are sequential (each depends on the prior).
TCK-444 and TCK-445 are deferred server-side capabilities (§18) and are only scheduled
after v1 lands.

## 16. Open questions

1. **Clone/push credentials.** Decided in §18: SSH/PAT for private repos and
   `git push` are hosted on the Almadel server and handed to Alimiel as a
   short-lived, expiring token — never mounted in the worker's environment.
2. **Ephemeral clone vs. bare mirror.** Fresh clone is slow for large repos. A
   bare mirror + `git worktree` per ticket is the obvious optimization; defer
   until it matters.
3. **Concurrency.** v1 is strictly sequential (one task at a time). The issue
   hints at concurrent/ephemeral workers — captured as the Phase 5 executor
   abstraction, not built now.
4. **Permissions/ask parity.** When does Alimiel regain the ability to hold a
   permission or question open for a human (serve-mode, §11)? This is the
   biggest functional gap vs. the plugin and must be scheduled explicitly.
5. **Non-task job handling.** Reply/permission/cancel/message jobs are ignored
   in v1; real handling depends on #4.
6. **`opencode run` flag verification.** Confirm the exact model/permission/
   exit-code semantics against the installed opencode version (spike in Phase 2).

## 17. Future: ephemeral workers

The supervisor's task lifecycle is deliberately one seam away from portable
workers. Extracting "run a command in a prepared directory and give me its exit
code" behind a `Worker`/executor trait means the same poll loop can later
dispatch to:

- a local subprocess (v1),
- a Docker container (`docker run -v <clone>:/work … opencode run …`),
- a k8s pod / job,
- a GitHub Actions workflow.

The server contract, the branch/commit/move protocol, and the column resolution
all stay identical — only the *executor* changes. Phase 5 defines that trait and
documents it so issue #18's "opportunity in the future" is a small addition, not
a second build.

## 18. Secrets & credentials (hosted on the server)

Requirement (from the ticket): **no long-lived credential lives on the
supervisor or worker.** Git credentials — and, in the future, LLM credentials —
are hosted on the Almadel server and delivered as **short-lived, expiring
tokens** over the same authenticated HTTP channel.

### 18.1 Git credentials (PAT / SSH)

- The project's `git_remote` credentials (a GitHub PAT or a repo-scoped SSH
  deploy key) are stored **on the Almadel server**, associated with the project.
- Per task (or per boot), Alimiel calls a new server endpoint — e.g.
  `POST /api/projects/{id}/git-credential` — and receives an **ephemeral,
  expiring credential**:
  ```json
  { "type": "pat" | "ssh",
    "value": "<pat-or-key-material>",
    "expires_at": 1789669999999 }
  ```
- Alimiel uses the credential only for the current clone/fetch/push, then
  discards it. If it expires mid-task, Alimiel re-requests a fresh one. The
  worker never persists it beyond a `0600` temp file for the SSH key, removed
  during cleanup.
- Wiring: PAT → `git -c http.extraHeader="Authorization: Bearer <pat>"` (or a
  one-shot `GIT_ASKPASS`); SSH → write the key to a temp file and run
  `GIT_SSH_COMMAND="ssh -i <tmpkey> -o IdentitiesOnly=yes"`.
- **Why this matters:** the worker is credential-less. A compromised or crashed
  ephemeral worker (§17) leaks at most a short-lived token that has already
  expired — which is what makes the container/k8s/gh-actions future safe.

### 18.2 LLM / opencode credentials (future — LiteLLM proxy)

- **v1:** opencode already holds its own model keys (env/config), so Alimiel
  runs opencode with its existing keychain and does not touch model auth.
- **Future:** the Almadel server becomes a **LiteLLM-compatible LLM proxy**.
  Model keys move off the workers and onto the server. opencode (or the worker)
  is pointed at the proxy with a **short-lived proxy credential** minted per
  task, using the same ephemeral-token pattern as §18.1.
  - Enables **rate limiting**, **cost accounting**, and **secure one-shot
    tasks**: a worker only ever sees a proxy token, never a real provider key.
  - The supervisor fetches the proxy credential alongside the git credential
    before spawning opencode, and injects it as the model auth (base URL + key).

### 18.3 Scope note

Both §18.1 and §18.2 require **new server capabilities** (secret store + minting
endpoint, and later the LiteLLM proxy). These are future server changes, not
Alimiel v1. Alimiel's client-side work is a small `fetch_credential` step in the
task lifecycle plus the git/SSH wiring above — isolated so the proxy can be
adopted later without touching the poll loop.
