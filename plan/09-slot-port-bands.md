# 09 — Slots & Port Bands

## A slot owns a primary checkout plus per-ticket worktrees

```
slot  →  fixed directory (~/src/almadel-api)          (the "primary" checkout)
      →  one opencode instance, one plugin
      →  PORT_BASE from the server at registration
      →  per-ticket worktrees under .almadel/wt/<ticket>, each on run/<ticket>
```

§2.2 previously assumed the plugin couldn't create a worktree and re-anchor its own
process, so a slot was a single fixed checkout and per-ticket isolation was
`git checkout -b run/TCK-412` inside it. That turned out to be the root cause of
the dirty-worktree failures: one dirty checkout blocks *every* ticket on the slot.

The plugin now creates a **separate `git worktree` per ticket** and re-anchors the
process via `process.chdir` before dispatch:

- On task: `prepareTicketWorktree` — `git worktree add .almadel/wt/<ticket> -b run/<ticket> <default_branch>` (or reuse the existing worktree on re-claim), then `chdir` into it.
- On stage end (move/cancel/fail): `chdir` back to the primary checkout, `git worktree prune`. The worktree and its branch stay on disk for review.

Isolation still holds — and now it holds *between tickets on the same slot*, which a
shared checkout could never guarantee.

The server's involvement is narrow but real:

- It stores `repo_root`, `default_branch`, `label` on the agent row (from registration).
- It allocates `port_base` at registration.
- It stores `tickets.branch` and returns it in the `task` job so the plugin knows
  which branch to check out.

Everything else (actual `git` operations) is plugin-side. The server is the source of
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

- Re-anchor the process to the primary checkout; leave the `run/TCK-412` worktree
  and branch in place for review.
- `git worktree prune` cleans up metadata for worktrees whose directories are gone.
- Each ticket gets a fresh worktree, so `node_modules` is cold per worktree — the
  accepted cost of isolation (the old shared-checkout "warm node_modules" win is gone).

These are plugin-side behaviours; the server just records the branch and the
default. The `takeover` action (`POST /api/tickets/{id}/takeover`) marks the ticket
human-owned and leaves the branch checked out so the human can open it themselves
(§5.5).

## Dirty-worktree rule (server doesn't cause it, but must surface it)

Never `git checkout -f` to recover (§14). A dirty worktree means the agent's
uncommitted work is in it — with per-ticket worktrees that is *expected* and is
preserved for review. The only git failures that still fail a ticket are the ones
the plugin can't recover from (e.g. `git worktree add` fails); the server records
the failure state and the error comment. The rule lives in the plugin, but the
server's failure handling (`10-failure-handling.md`) treats a worktree-setup
failure as a terminal `failed` ticket, not a silent requeue.
