# 08 — Registration & Join Tokens

The enlistment path. Installing the plugin does not make an instance a worker;
loading it registers a `/almadel` command and nothing else. Intent is expressed at
launch time, per-process, never persisted (§2.11).

## Registration (`POST /api/agents`)

Body per §3.2:

```json
{
  "project": "almadel-api",
  "repo_root": "/home/me/src/almadel-api",
  "git_remote": "git@github.com:me/almadel-api.git",
  "default_branch": "main",
  "label": "laptop",
  "opencode_version": "1.x",
  "capabilities": { "tools": true, "permission_hook": true }
}
```

Server processing:

1. **Project binding.** Resolve `project`. Unknown → `404` (token is per-project;
   the join token already names it, but the body must still agree).
2. **Remote check.** Compare `git_remote` against the project's registered remote.
   Mismatch → **refuse registration** (`409`), not a warning — a warning in a log
   nobody reads is not a boundary (§3.2). Explicit `project` beats inferring from
   the remote (monorepos, forks, mirrors all break inference).
3. **Capability gate.** Require `opencode_version` above the minimum and
   `capabilities.tools` + `permission_hook`. Failure → `409` with the required
   version. Refuse, don't degrade: an agent that can't call `almadel_move` can't
   finish a stage (§9.2).
4. **Upsert slot.** `INSERT ... ON CONFLICT (project_id, repo_root, label)` reuses
   the row: new `agent_id`, regenerate the token, keep `name` (display name), update
   `opencode_version`, stamp `registered_at` + `last_poll`.
5. **Allocate port band.** Compute `port_base` for this slot (§09).
6. **Respond** `{ agent_id, name, token, port_base }`. The token is returned exactly
   once and never logged or stored anywhere else.

## Deregister (`DELETE /api/agents/{id}`)

`/almadel leave` or clean shutdown. Requeues the held ticket **immediately** (no
lease wait) and removes the row. From the server's view, `leave` and quitting
opencode are equivalent except for latency (§9.1): a hard quit just waits out the
90s lease and the sweep requeues then.

## Join tokens (`join_tokens`)

Per-project, revocable, no global join (§3.4). A join link names a project:

```
https://almadel.example.org/join?t=<token>
```

| Field | Meaning |
|---|---|
| `token` | opaque random (PK) |
| `project_id` | which project it enlists against |
| `expires_at` | optional TTL |
| `revoked` | soft-delete; check both on use |

The token's only job is to prove "a human wants to enlist against *this* project".
The plugin passes it to `/api/agents` (or uses it to fetch the project's remote for
its own check); the server verifies `exists`, `not revoked`, `not expired`.

## `/join` page

Serves the two-step enlistment (§9.2):

1. Copy-pasteable install line: `bunx @almadel/opencode-plugin init` (adds the
   plugin to `opencode.json`; no URL, no token — just code on the machine).
2. Then, in the restarted instance: `/almadel join <server> --token <t>`.

The page is agent-readable but the deterministic command path is primary — an LLM
can't restart its own process or consent for its owner (§9.2 "Make the
deterministic path primary"). The page stays **pending** and ticks green over the
roster SSE stream the moment a registration lands, so "installed but never joined"
is visible as a dangling pending join (§14).

## Two enlistment intents, one mechanism (§2.11)

| | How intent is expressed | Who |
|---|---|---|
| Interactive | `/almadel join <server>` typed in the session | the person, now |
| Unattended | `ALMADEL_JOIN` / `ALMADEL_TOKEN` in the env | whoever wrote the unit file |

The server is identical in both cases — it only ever sees a registration. The
difference lives entirely in how the *plugin* decides to call `/api/agents` (on
command vs. on load). The server must not assume persistence: a restarted unattended
worker looks like a brand-new registration and is reconciled by the slot upsert.

## Capability gate details

The `capabilities` object is the server's contract with plugin versions:

- `tools: true` — can register `almadel_*` tools.
- `permission_hook: true` — the `permission.hook("evaluate")` surface exists (§12.2).

The gate is the enforcement point for the Phase-1 spike: before building on the
permission hook, verify it fires on the pinned opencode version (§15, §12.2). The
server just needs to *carry* the flag and refuse when it's absent.

## Token hygiene

- Tokens are scoped to one ticket at a time (the ticket the token's agent currently
  holds). An agent cannot touch another agent's ticket even by id (§8).
- Tokens are revocable (server-side revocation invalidates the middleware lookup).
- Tokens never appear in committed config, prompt text, or logs (§9.2 — the whole
  reason they go on the command, not in `opencode.json`).
