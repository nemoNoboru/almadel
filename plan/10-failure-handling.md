# 10 — Failure Handling

The server is the backstop for correctness (§2.6: agent moves are semantic, server
moves are guaranteed). This table from §14 is the acceptance checklist; the columns
are the server's responsibilities.

| Failure | Detection | Server response |
|---|---|---|
| Agent vanishes | `last_poll` > 90s | Requeue its tickets, mark offline |
| Agent forgets to move | Session idle, ticket in-flight | Move by outcome |
| Permission unanswered | Pending > 1h | Auto-deny, set `blocked` |
| `almadel_ask` times out | 5 min, no answer | Mark deferred, agent ends turn, resume by injection |
| opencode too old for tools | Capability check at registration | Refuse registration, `409` with required version |
| Installed but never joined | Nothing registers | Dormant by design; `/join` stays pending |
| Interactive agent crashes | Poll stops | Lease expiry requeues ticket; slot gone until rejoin |
| Unattended agent crashes | Poll stops | systemd restarts; env vars rejoin it (plugin-side) |
| Plugin didn't load | `/almadel` command missing | Visible in-app immediately (plugin-side) |
| Server unreachable after join | Poll fails | Retry with backoff (plugin-side); server does nothing |
| Wrong-project job | Plugin verify (§3.1) | Error comment, no checkout (plugin reports back) |
| Registration mismatch | `git_remote` differs | Refuse registration (`409`) |
| opencode crashes | Poll stops | systemd restarts; lease expiry requeues |
| Server restarts | Plugins reconnect on next poll | Nothing to do — poll is stateless |
| Dirty slot directory | Checkout fails | Fail ticket with the git error |

## The periodic sweep (one timer, three jobs)

`domain/lease.ts` runs every ~15s and does three things:

1. **Lease expiry.** Agents with `last_poll < now - LEASE_TTL` → requeue their
   in-flight tickets (`running` → `ready`, clear `agent_id`/`claimed_at`, comment
   `system: requeued`), then `notify` so a parked poll picks it up.
2. **Permission auto-deny.** `permissions.decision IS NULL AND created_at < now - PERMISSION_TTL`
   → deny, stamp `decided_at`, resolve/queue the permission job, move the ticket
   back to `running`.
3. **Deferred-ask sweep.** (covered in `06-blocking-and-ask.md`) — no separate
   timer needed; the answer path already handles deferred questions via the `reply`
   job.

Each sweep is idempotent and re-runnable — a crash mid-sweep just re-runs on the
next tick.

## Requeue, not lose

Requeue always preserves the ticket thread (comments/events) and leaves the branch
in place. A re-run after a crash starts from the same artifacts, checks out the
existing `run/TCK-412` branch if present, else creates it. Nothing is lost; you
just may have one fewer agent until you notice (§2.11).

## "Forgets to move" — server moves by outcome

If a session goes idle (telemetry reports `idle` or the poll shows the ticket still
in-flight with no move) the server moves it by outcome: to the column's `fail_column`
if the run ended without a successful `almadel_move`, else the `next_column`. The
exact heuristic (idle how long? how does "ended successfully" look in telemetry?)
is an open question — see `12-open-questions.md`. The principle is fixed: a
transition that only happens if an LLM remembers to call a tool sometimes doesn't
happen, so the server must be able to force it.

## Fail loudly, never force-recover

The dirty-slot rule from §14: **never `git checkout -f` to recover.** A dirty slot
means someone was working in it; force-discarding their changes to run a ticket
ends adoption. The plugin fails the ticket with the git error; the server records
`state='failed'` and the error comment. This is a terminal state, not a requeue
candidate — a retry would hit the same dirty directory.

## Server restart = nothing to do

The poll is stateless; plugins reconnect on their next poll and the claim query
resumes. The only recovery concern is WAL (which is why it's on) and the notify
map, which is in-memory and simply repopulates as polls arrive. No server-side
session state exists to lose.
