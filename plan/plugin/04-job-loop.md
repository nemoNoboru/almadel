# 04 — Job loop, dispatch, and git

## The claim (long poll)

The plugin parks a poll on `POST /api/claim` for ~35s (§8). It carries telemetry,
doubles as the heartbeat, and returns either a job or a `204 No Content`:

```json
{ "project": "almadel-api", "agent": "agt_abc",
  "slot": { "status": "working", "ticket": "TCK-412", "since": 1757400000 } }
```

The poll is `Promise.race`-shaped on the server (`waitForNotify` vs `sleep(35s)`);
the plugin side is simply a loop: await the claim, handle the result, claim again.
The 35s ceiling must sit under whatever the ingress kills idle connections at (§8).

## The job union

```ts
type Job =
  | { type: "task";       project: string; ticket: string; prompt: string; branch: string }
  | { type: "reply";      project: string; ticket: string; text: string }
  | { type: "permission"; project: string; ticket: string;
      permission_id: string; decision: "allow" | "deny"; scope: Scope }
  | { type: "cancel";     project: string; ticket: string };
```

New tickets, replies into held sessions, and permission decisions all arrive
through this one channel. Every job carries `project` so the plugin can
re-verify (§3.1).

## Dispatch (dispatch.ts)

On `{ type: "task" }`:

1. **Verify project** (§3.1):

```ts
if (job.project !== config.project) {
  await reportError(job.ticket, "project mismatch");
  return; // do not check out, do not prompt
}
```

2. **Checkout the branch** (`git checkout -b run/TCK-412`) in the slot directory.
   The branch name is in the job, not constructed from prompt text.
3. **Create a session** and **send the rendered prompt** — the column template
   with title, body, and full thread inlined (`{{ticket.*}}`, `{{thread}}`,
   `{{branch}}`, `{{project}}`, `{{port_base}}` are rendered server-side at
   dispatch, §4.2; the plugin sends the already-rendered text).
4. Set `state.ts` status to `working`, ticket to the job's ticket.

The plugin must not re-render the prompt — rendering is a server/column concern
and lives with the column config (§4.1).

## Reply / permission / cancel jobs

- `reply` → `ask.ts`: resolve the pending `almadel_ask` if one is parked, else
  inject the text into the still-live session (the deferred path, §12.6).
- `permission` → `permission.ts`: resolve the pending hook with the decision.
- `cancel` → abandon the ticket, end the session, mark the branch for cleanup.

## Git handling (git.ts)

The hard rule (§14): **never `git checkout -f` to recover.** A dirty slot means
someone was working in it; force-discarding their changes to run a ticket ends
adoption. A checkout that fails on a dirty directory fails the ticket with the
git error.

Lifecycle of a slot's branch:

1. Before a ticket: ensure the slot is on the default branch (return to it after
   the previous ticket).
2. On task: `git checkout -b run/<ticket>`.
3. After the stage (move/cancel/idle fallback): leave the ticket branch in place
   for review, return the slot to the default branch. `node_modules` stays warm —
   the main practical gain over worktree-per-ticket (§13).
4. Periodically prune merged `run/*` branches — branch hygiene, not directory
   hygiene (§13). This is likely a server/ops concern, but the plugin must not
   delete branches it created mid-run.

`PORT_BASE` (§13) arrives from the server at registration and is surfaced to the
agent via the column prompt's `{{port_base}}` template variable — the plugin
itself does not allocate ports; it passes the band through.

## Re-verify everything

Project mismatch is the one correctness boundary the plugin enforces itself
(§3.1). It must also not trust the branch name, ticket id, or prompt in a job
beyond using them verbatim — they come from a server the operator controls, but
defense in depth on `project` is cheap and prevents the wrong-repo-write failure
mode (§3.1).
