# Almadel — Server Backend Plan

## What this is

Almadel is a self-hosted control plane for coding agents. A ticket written into a
column becomes a prompt; an agent (an opencode instance that joined by URL) picks
it up, works on its own branch, and moves the card forward. When it gets stuck it
asks a human in a chat panel and waits.

This `plan/` folder is the implementation plan for **the server backend** — the
`almadel` package: HTTP server, SQLite database, embedded UI, CLI. It treats the
agent-side plugin (`@almadel/opencode-plugin`) as a client defined by a fixed HTTP
contract; the contract is specified here (see `03-api-surface.md`) so the two
packages can be built independently against it.

The plugin has its own plan (not in this folder). The only things the server needs
to know about the plugin are: what it sends on each endpoint, and what it expects
back.

## The server's role in one paragraph

The server is **purely an HTTP server**. It has no outbound connections at all.
Agents dial *in*: they long-poll `/api/claim` for work, push batched events to it,
and call it on the agent's behalf when a tool fires. Browsers subscribe over SSE.
All state lives in one SQLite file (WAL mode) that can be operated by hand. The
server never dials an agent, never talks to opencode, and never guesses what an
agent is doing — it is told, and it reconciles from the polling heartbeat.

## Package boundaries

| Package | Installed by | Contains | Planned here? |
|---|---|---|---|
| `almadel` | whoever runs the board | server, UI, SQLite, CLI | **Yes — this folder** |
| `@almadel/opencode-plugin` | every agent machine | plugin, tools, config snippet | No (separate plan) |

## Scope of the server

In scope:

- SQLite schema, migrations, WAL configuration.
- Every HTTP endpoint in §8 of `vision.md` (agent-facing, plugin-facing, browser-facing).
- Atomic claim + notify, long-poll mechanics, lease expiry, requeue.
- Event storage and SSE fan-out (roster stream, per-ticket stream).
- The ask loop and permission flow **as the server owns them** (decision recording, job queueing, reconciliation, auto-deny).
- Roster/presence, `needs_you` count.
- Registration, per-project join tokens, capability/version gate.
- Port-band allocation for slots.
- Embedded HTMX/SSE board UI (thin, but owned here).
- CLI (`almadel start`), single-executable packaging (Phase 5).

Out of scope (owned elsewhere or deferred):

- The plugin itself, `almadel_*` tool definitions, checkout/dispatch.
- Lifecycle of agent processes (systemd, restart policy).
- Anything from §16 "Deliberately deferred" (NATS, agent-to-agent, sandboxing, cross-project tickets).

## Hard constraints carried into every doc

These are the decisions from `vision.md` §2 that the server design must not violate.
Each maps to one of the docs below.

1. **One process, one SQLite file.** Not horizontally scalable. `bun:sqlite` is
   synchronous, so transactions are atomic by construction — provided **nothing
   `await`s inside the claim transaction** (§2.9). → `04-claiming-queueing.md`
2. **Agents dial out; the server never dials in.** No outbound connections.
   Poll doubles as the heartbeat (§2.3). → `03-api-surface.md`, `04-claiming-queueing.md`
3. **All state lives in the ticket.** Plans, questions, answers, branch names,
   comments — all rows, never process-local (§2.4). → `02-data-model.md`
4. **Projects are the namespace, not a filter.** Scoping enforced in the claim
   query *and* re-verified by the plugin on receipt (§2.5, §3). → `08-registration-join-tokens.md`
5. **Agent moves are semantic; server moves are guaranteed.** The server moves a
   ticket by outcome when a session goes idle with it still in-flight (§2.6).
   → `10-failure-handling.md`
6. **Blocking happens inside a tool call, with a timeout.** Fast path resolves the
   pending call; slow path falls back to message injection (§2.7, §12.6).
   → `06-blocking-and-ask.md`
7. **Plugin tools are the only path.** No curl fallback; endpoints that move state
   require the agent's registration token (§2.8). → `03-api-surface.md`
8. **One shared `zod` schema** for the job union, telemetry, and event payloads,
   imported by server, plugin, and frontend (§2.9). → `01-architecture.md`
9. **Enlistment is per-process and never persisted.** Registration upserts on
   `(project_id, repo_root, label)`; restart reuses the row, display name survives,
   agent id regenerates (§2.11, §9.2). → `08-registration-join-tokens.md`
10. **Presence is derived, never stored.** An agent is online iff `last_poll` is
    fresh; nothing writes `offline` (§7). → `07-roster-presence.md`

## Reading order

| Doc | Covers |
|---|---|
| `01-architecture.md` | Process model, module layout, data flow, shared schemas |
| `02-data-model.md` | SQLite schema, migrations, WAL, seeding |
| `03-api-surface.md` | Full HTTP contract, auth model, validation |
| `04-claiming-queueing.md` | Atomic claim, notify, long poll, WIP, lease expiry |
| `05-events-streaming.md` | Event storage, fan-out, SSE endpoints |
| `06-blocking-and-ask.md` | Ask loop, permission flow, reconciliation |
| `07-roster-presence.md` | Agents, status model, `needs_you` |
| `08-registration-join-tokens.md` | Registration, join tokens, capability gate |
| `09-slot-port-bands.md` | `PORT_BASE` allocation, branch/slot lifecycle |
| `10-failure-handling.md` | Failure table, requeue, auto-deny, dirty-slot rule |
| `11-build-order.md` | Phases 1–5 mapped to concrete server tasks + acceptance criteria |
| `12-open-questions.md` | Unresolved decisions that block or shape the build |
