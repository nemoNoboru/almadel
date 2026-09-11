# 04 — Claiming & Queueing

The claim path is the heartbeat of the whole system: a parked poll is a living
agent, and the atomic claim is what guarantees a ticket runs on exactly one slot.

## The claim query

```sql
SELECT * FROM tickets
WHERE project_id = ? AND state = 'ready'
ORDER BY priority DESC, created_at ASC
LIMIT 1;
```

Scoped by project, always. There is no unscoped claim path — §2.5 depends on it.

## Atomic claim, with notify

The interesting part is the *shape* of the handler, not the SQL:

```ts
// server/routes/claim.ts
const job = await Promise.race([
  waitForNotify(projectId, agentId),   // wakes when something becomes claimable
  sleep(POLL_WINDOW).then(() => null), // 35s
  request.signal.aborted,              // client disconnected
]);

if (job) return Response.json(job);

// no notify pending → try a synchronous claim (atomic, no await inside)
const ticket = claimNow(projectId);    // BEGIN; SELECT; UPDATE state='running';
                                       // upsert agents.telemetry; COMMIT
if (ticket) return Response.json(makeTaskJob(ticket));

return new Response(null, { status: 204 });
```

`claimNow` runs entirely synchronously on the `bun:sqlite` connection. The
`UPDATE tickets SET state='running', agent_id=?, claimed_at=? WHERE id=?` uses a
guarded `WHERE state='ready'` so two concurrent claims can't both win — the second
sees zero rows affected and returns null.

### Notify, not polling-every-second

A parked poll doesn't wake on a timer and then re-scan; it waits on an in-process
pub/sub (`server/notify.ts`) keyed by project. Ticket creation broadcasts on the
project's channel (§4.4, §11). Implementation is a `Map<projectId, Set<resolver>>`
plus a `notify(projectId)` that resolves and drains the waiting resolvers. This is
what makes new work dispatch in sub-second time instead of up to a poll window.

## Telemetry rides the poll

Every claim carries current slot state (§5.3):

```json
{ "project": "almadel-api", "agent": "agt_abc",
  "slot": { "status": "working", "ticket": "TCK-412", "since": 1757400000 } }
```

The server writes this into `agents.status/ticket_id/since` and stamps `last_poll`.
It is up to 35s stale and **can never drive the badge** — detection is push-driven
(§5.3). Telemetry is the reconciliation backstop (§12.5), not the UI source.

## WIP limits

A column's `wip_limit` caps how many tickets that stage occupies at once (§4.3).
Enforced at two points:

1. **Claim eligibility:** a `ready` ticket in column C is only claimable if C's
   current `running`/`blocked_*` count is below `wip_limit`. The claim query adds a
   `NOT EXISTS`/count check on the column.
2. **Drag/drop:** dragging a card into a column over its limit is either rejected
   with a message or allowed-to-queue (config decision — see `12-open-questions.md`).

Natural ceiling is total slots in the project; limits above that just mean queueing.

## Lease expiry and requeue

An agent that stops polling (crash, network drop, process kill) must not strand its
ticket. A periodic sweep (`domain/lease.ts`, every ~15s) finds:

```sql
SELECT * FROM agents WHERE last_poll < ?;   -- now - LEASE_TTL (90s)
```

and for each stale agent: mark it offline (derived), requeue its held ticket
(`state='running'` → `'ready'`, clear `agent_id`/`claimed_at`, comment
`system: agent vanished, requeued`), and broadcast `notify` so a parked poll picks
it up.

`DELETE /api/agents/{id}` (deregister on `/almadel leave` or clean shutdown) does
the same requeue **immediately** rather than waiting out the lease (§9.1).

## Ticket creation and drag semantics

- **Create** in a prompted column → `state='ready'` → `notify(projectId)` (§11.1).
- **Drag into a prompted column** → same as create: marks `ready`, broadcasts.
  There is no "run" button — moving a card *is* running it (§4.4).
- **Drag a `running` ticket out** → cancel it first (server-side: requeue or mark
  cancelled depending on target).

## Requeue correctness

Requeue must preserve the ticket's own thread (comments/events) so a re-run after a
crash starts from the same artifact history. Branch handling: the `run/TCK-412`
branch is left in place; on re-claim the plugin checks out the *existing* branch if
present, else creates it. (Branch creation is plugin-side; the server only stores
`tickets.branch` and returns it in the task job.)
