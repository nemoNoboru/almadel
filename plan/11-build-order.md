# 11 — Build Order

Five phases from §15, translated into server-side tasks with acceptance criteria.
Plugin tasks are noted only where they gate a server task. The Phase-1 spike is
first and non-negotiable (§15: "worth knowing on day one").

## Spike 0 — Verify the permission hook (before Phase 1)

The architecture's main advantage over the old design evaporates if the permission
hook doesn't fire on the pinned opencode version (§12.2, §15).

- Pin an opencode version; confirm `permission.hook("evaluate")` fires for `ask`
  **and** `allow` decisions and lets the hook change the effect.
- Record the version in the capability gate (`08-registration-join-tokens.md`).
- **Accept:** a tiny plugin calling the hook observes an event and can mutate its
  effect. If it fails, escalate before writing Phase 1.

## Phase 1 — The boring path

"A ticket goes in, a branch comes out. This is the whole product."

Server tasks:

1. Scaffold the package (`01-architecture.md` module layout), Bun + TS + `bun:sqlite`.
2. `db/schema.ts` + migration `0001` + WAL pragmas + `seed.ts` default board.
3. Projects + columns CRUD (`GET/PUT /api/projects/{id}/columns`).
4. Ticket CRUD + drag semantics (`state` transitions, `notify` broadcast).
5. Registration (`POST /api/agents`, upsert, remote check, capability gate) +
   `DELETE`.
6. Claim (`POST /api/claim`: atomic claim, notify, 35s long poll, 204).
7. Plugin-facing tools endpoints: `GET /api/tickets/{id}`, `comment`, `move`
   (token-scoped middleware).
8. `almadel start` CLI; `almadel init` (empty-DB bootstrap).
9. Minimal board UI (`/p/{project}`) rendering columns + cards; drag to move.

**Accept:** one project, one agent. Create a ticket in a prompted column → it
dispatches → the agent's `almadel_move` lands it in the next column → the board
shows it. A branch name is stored on the ticket. No streaming, no blocking.

## Phase 2 — Visibility

1. `events` table + `POST /api/tickets/{id}/events` (batch append, fan-out).
2. `/api/tickets/{id}/stream?after=<seq>` (replay + live).
3. `/api/roster` + `/api/roster/stream`.
4. Live-log pane in the UI.
5. `cancel` endpoint + UI action.

**Accept:** a running ticket streams its transcript to the board live; a browser
refresh/ reconnect resumes at the right `seq`; cancelling a running ticket requeues
it.

## Phase 3 — The ask loop (the differentiator)

1. `questions` + `/ask` + `GET /api/questions/{qid}` long poll.
2. `reply` endpoint with fast/slow branching (parked-poll vs `reply` job).
3. `permissions` + `/permission-request` + `/permission` endpoints.
4. `pending_messages` (nudge) for `working` slots.
5. `blocked_question` / `blocked_permission` states, `needs_you` badge, roster status.
6. Permission auto-deny timer + deferred-ask sweep (fold into the lease sweep).
7. Chat panel + permission buttons in the UI.

**Accept:** an agent calling `almadel_ask` blocks and gets your answer as its tool
result; a permission hook pauses and your allow/deny resolves it; a question left
overnight resumes by message injection. The badge is correct on a cold page load.

## Phase 4 — Multi-project, multi-agent

1. `join_tokens` + `/join` page + token verify on registration.
2. Roster grouping by project; global `needs_you`.
3. Lease expiry + requeue sweep (formalize the §14 table).
4. Port-band allocation + `{{port_base}}` in prompt rendering.
5. WIP limits on claim eligibility and drag.
6. `takeover` action.

**Accept:** two projects, several slots across them. A crashed agent's ticket
requeues within the lease window; two slots on one machine get distinct port bands;
WIP limits cap a column; join links enlist against exactly one project.

## Phase 5 — Packaging

> Superseded in detail by `13-packaging-release.md` (UI bundling, compiled bin,
> GitHub-release workflow). This phase keeps the `--compile` single-executable goal.

1. `bun build --compile` single executable.
2. npm publish `almadel` (and the plugin, per its plan).
3. systemd unit + Dockerfile (unattended worker join via `ALMADEL_JOIN`/`ALMADEL_TOKEN`).
4. Reverse-proxy note: `INGRESS_IDLE_TIMEOUT` above the 35s poll.

**Accept:** `almadel start` runs from a single binary on a clean machine; a systemd
unattended worker survives restarts and rejoins automatically.

## Cross-phase invariants

- **Shared zod schemas** land in Phase 1 (blocked on `12-open-questions.md` Q1).
- **Never `await` inside the claim transaction** — holds in every phase.
- **Presence derived, badge from a query** — holds in every phase.
- Every phase ends with the sweep/test suite green (unit tests on `domain/*`; no
  integration framework assumption — check what's idiomatic for Bun/TS here).
