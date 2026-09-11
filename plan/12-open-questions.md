# 12 — Open Questions

Decisions that block or shape the server build. Resolve before the phase that needs
them.

## Blocking Phase 1

1. **Where do the shared zod schemas live?** §2.9 wants one schema shared by
   server, plugin, frontend; §2.10 says two packages. Options in
   `01-architecture.md`: internal `@almadel/shared` workspace package (recommended),
   plugin-exports-schemas, or duplication. This blocks Phase 1 task 1.
2. **Default board seeding.** Is the §4.1 five-column default (Spec→Planning→Review
   →Implement→Testing) shipped by `almadel init`, or is the first board always
   hand-authored? Affects `seed.ts` and whether a fresh install is usable immediately.

## Blocking Phase 2

3. **Event idempotency on retry.** A retried `POST /api/tickets/{id}/events` after
   a network blip could double-append. Client sends `last_seq`/batch id and server
   dedupes, or accept the occasional duplicate in the log? (Transcript is
   non-critical, but `seq` skew would break replay.)
4. **SSE backpressure.** Slow browser subscribers evicted on write error — but what
   timeout? And is there a max-buffered-events per subscriber to bound memory?

## Blocking Phase 3

5. **Does a blocked agent hold its slot?** §17 Q1. Currently indefinitely: blocked
   = slot occupied. Accept it, or let a blocked session persist while the slot claims
   new work? The latter is much more state (multiple live sessions per slot) and
   breaks §5.1's one-slot-one-ticket model. Recommend: accept indefinite hold for v1.
6. **"Forgot to move" heuristic (§10).** Idle how long before the server moves by
   outcome? And how does "ended successfully" show in telemetry — does the plugin
   report a terminal `session idle` event the server can key on, or does the server
   infer from `state=running` + `idle` + elapsed time? Needs a concrete trigger.
7. **Permission scope semantics.** `once | always | session` — does "always" write
   back to opencode's own permission rules (plugin-side), or does the server store
   an auto-policy it replays on future matching hooks? The server's role differs
   sharply; clarify who persists "always".

## Blocking Phase 4

8. **WIP-limit overflow behaviour.** Dragging a card into a column at its `wip_limit`:
   reject with an error, or allow and let it sit `ready` (queued)? §4.3 implies
   queueing; the drag UX needs the answer.
9. **Port-band allocation details.** `BASE`/`BAND_WIDTH` config, and is the band
   stable per slot (recommended) or reallocated each registration? Stability changes
   whether bands are stored on the upsert row or a counter.

## From §17 (product-level, but the server design depends on them)

10. **Where do PRs happen?** §17 Q2. Agent runs `gh pr create`, or Almadel does it
    on move-to-review (keeps tokens out of the agent's env). If the server does it,
    that's a server feature (Phase 4+); if the agent does, it's a permission-policy
    concern (§12.4 escalation list).
11. **Secrets.** §17 Q4. Scoped short-lived tokens per project, not a PAT with org
    access. If Almadel mints these, it's a server feature with a credential store —
    deliberately deferred, but must not paint the schema into a corner.
12. **Prompt versioning.** §17 Q5. Store the *rendered* prompt on the ticket at
    dispatch so editing a column doesn't silently change in-flight behaviour. Cheap
    to do: a `dispatch_prompt` column or a `comments` `kind='prompt'` row at claim.
    Recommend doing it from Phase 1.
13. **Who reviews?** §17 Q6. Parallel agents → parallel diffs; attention doesn't
    parallelise. Out of the server's scope but shapes WIP limits and the Review
    column's human-gate ergonomics.
14. **Multiple slots per machine.** §17 Q3. Two checkouts + two instances (matches
    §2.2) vs one instance with sessions (breaks fixed-directory). Server assumes the
    former; confirm so `repo_root` stays the slot identity key.
