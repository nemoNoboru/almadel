# 09 — Slots & Port Bands

## A slot is a fixed checkout

```
slot  →  fixed directory (~/src/almadel-api)
      →  one opencode instance, one plugin
      →  PORT_BASE from the server at registration
```

§2.2: the plugin can't create a worktree and re-anchor its own process, so a slot
is a fixed checkout and per-ticket isolation is `git checkout -b run/TCK-412`
inside it. Isolation still holds: two slots are two directories, two checkouts, two
branches.

The server's involvement is narrow but real:

- It stores `repo_root`, `default_branch`, `label` on the agent row (from registration).
- It allocates `port_base` at registration.
- It stores `tickets.branch` and returns it in the `task` job so the plugin knows
  which branch to check out.

Everything else (actual `git` operations, keeping `node_modules` warm, returning to
the default branch between tickets) is plugin-side. The server is the source of
truth for *which branch* a ticket ran on, because that's durable ticket state (§2.4).

## Port bands

Why: two slots on one machine both running `npm run dev` fight over port 8000. The
column prompt tells the agent its band (§4.2 `{{port_base}}`).

Allocation: each slot in a project gets a distinct band at registration. Simplest
correct scheme: a per-project counter, `port_base = BASE + slot_index * BAND_WIDTH`
with a configurable `BASE` and `BAND_WIDTH` (e.g. `BASE=8000`, `BAND_WIDTH=100`).
Store `port_base` on the agent row; free it on deregister (or keep it stable per
slot via the upsert, since a restarted slot should keep its band). Stability
preferred: key the band off the slot's stable identity (the upsert row), not a
monotonic counter that would hand a new band to a restarted worker and change the
prompt template mid-project.

`{{port_base}}` renders into the column prompt at dispatch (§4.2), so the agent
starts with everything and needs no fetch to begin.

## Between tickets

- Return to `default_branch`, leave the `run/TCK-412` branch in place for review.
- `node_modules` stays warm — the main practical gain over worktree-per-ticket.
- Periodically prune merged `run/*` branches (branch-hygiene, not directory-hygiene).

These are plugin-side behaviours; the server just records the branch and the
default. The `takeover` action (`POST /api/tickets/{id}/takeover`) marks the ticket
human-owned and leaves the branch checked out so the human can open it themselves
(§5.5).

## Dirty-slot rule (server doesn't cause it, but must surface it)

Never `git checkout -f` to recover (§14). A dirty slot means someone was working in
it. The plugin fails the ticket with the git error; the server records the failure
state and the error comment. The rule lives in the plugin, but the server's failure
handling (`10-failure-handling.md`) treats a checkout failure as a terminal
`failed` ticket, not a silent requeue.
