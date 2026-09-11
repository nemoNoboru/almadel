# 02 — Enlistment, config, and commands

## Config (loadConfig)

The plugin knows its own working directory (`directory` from the plugin
initialiser). Registration therefore declares the project binding explicitly;
the server sanity-checks it (§3.2):

```json
{
  "project": "almadel-api",
  "repo_root": "/home/me/src/almadel-api",
  "git_remote": "git@github.com:me/almadel-api.git",
  "default_branch": "main",
  "label": "laptop"
}
```

`loadConfig(directory)` derives:
- `repo_root` — `directory` (the slot's fixed checkout).
- `git_remote` — read from `git remote get-url origin` (fall back to any single
  remote). Used only for the server's mismatch check, never to infer the project.
- `default_branch` — from git (e.g. `main`/`master`), overridable.
- `project` — from the join command or `ALMADEL_JOIN` (never inferred).
- `label` — short human tag, e.g. `laptop`, or the systemd `%i` instance name.

The `project` is **not** inferred from the remote — monorepos, forks and mirrors
all break inference (§3.2). It is always supplied by the human or the env var.

## Registration (register.ts)

`POST /api/agents` with the payload above plus capability data. Returns agent id
and display name. The server:

- **Upserts on `(project_id, repo_root, label)`** so restarts reuse the row
  instead of leaving ghosts (§7 / §9.2). The agent id is regenerated; the display
  name is stable across restarts.
- **Refuses registration on `git_remote` mismatch** (§3.2) — a warning in a log
  nobody reads is not a boundary.
- **Refuses registration on capability failure** (§9.2):

```
409  almadel requires opencode >= 1.x with plugin tool support.
     found 0.9.4 — upgrade and restart.
```

The plugin therefore sends `opencode_version` and a capability flag in the
registration payload. **Refuse, don't degrade** — an agent that can't call
`almadel_move` can't finish a stage (§9.2).

## Enlistment intent (two forms, both at launch time)

Vision §2.11: installing the plugin does **not** make an instance a worker.
Loading it registers `/almadel` and nothing else. Intent is expressed exactly
two ways:

| Form | How | Who |
|------|-----|-----|
| Interactive | `/almadel join <server> [--token t]` in-session | the person, now |
| Unattended | `ALMADEL_JOIN` / `ALMADEL_TOKEN` in the environment | whoever wrote the unit file |

Unattended workers join at load only when **both** env vars are present. The
plugin writes **nothing to disk** in either case. No `.almadel.json`, no dotfile
to gitignore, no remembered state (§2.11).

## Commands (commands.ts)

| Command | Effect |
|---------|--------|
| `/almadel join <server> [--token t]` | Register and start polling, for this process only |
| `/almadel status` | Server, project, agent name, current ticket, connection state |
| `/almadel leave` | Deregister, requeue any held ticket, go dormant |

Notes:

- **`join` refuses if the current session already has history**, with a message
  explaining that the instance becomes a worker and tickets will check out
  branches in this directory. `--force` overrides (§9.1).
- **`status` is first-class** — "am I actually connected, and to what?" is the
  first question when something looks wrong, and answering it inside opencode
  beats going to the board (§9.1).
- **`leave` and quitting opencode are equivalent** from the server's view; the
  only difference is `leave` requeues immediately instead of waiting out the 90s
  lease (§9.1).
- **None persist anything.**

## The token lives on the command, not in a file

`opencode.json` is usually committed. A token in it is a credential in git, and a
server URL in it means every teammate who opens the repo enlists by opening it.
Passing the token to `join` keeps the committed file free of both (§9.2). The
`init` one-liner (Phase 5) only adds the plugin declaration to `opencode.json`,
no URL, no token.

## Lifecycle of a join

1. Human runs `bunx @almadel/opencode-plugin init` → plugin added to
   `opencode.json`, next-step printed (no URL, no token).
2. Restart opencode (loads the plugin; `/almadel` now autocompletes — the
   built-in verification that it loaded, §9.2).
3. `/almadel join https://server --token <t>` → `register.ts` POSTs, server
   upserts the slot and returns agent id + name.
4. `poll()` starts. The `/join` page ticks green over the roster SSE stream.

## Rejoin semantics

Every process start is a fresh registration; the server's upsert key
`(project_id, repo_root, label)` prevents ghost rows (§9.2). `label` must
therefore be deterministic for unattended workers (e.g. the systemd `%i`
instance) or restarts accumulate slots. This is a server concern but the plugin
must surface `label` faithfully and not randomise it.
