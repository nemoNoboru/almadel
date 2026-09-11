# Almadel Plugin — Implementation Plan

This folder (`plan/plugin/`) is the implementation plan for
**`@almadel/opencode-plugin`** — the worker half of Almadel. It is written for
the agent(s) building the plugin and derives entirely from `vision.md` (the v2
plugin architecture). It does **not** cover the server package (`almadel`), the
embedded UI, or the frontend, except where the plugin's contract with them must
be pinned down. The server's own plan lives in `plan/` (see `../00-overview.md`).

## What the plugin is

Almadel is a kanban board where columns are prompts and agents are opencode
instances that joined by URL. The plugin is the worker: it lives **inside** an
opencode process, long-polls the Almadel server for jobs, does the git/branch
work in its fixed checkout directory, drives the session, and pushes events
back. There is no separate worker process and no scrape of an SSE stream — the
plugin observes and drives its own session through the `client` handle opencode
gives it.

The two things that make this package worth building at all (per vision §18):
**remote enlistment** (a hosted board machines dial into by URL) and **the ask
loop** (an agent stops mid-run, holds its session, and is unblocked by a human
in chat). Both live in the plugin.

## How to read this folder

| File | Contents |
|------|----------|
| `01-architecture.md` | Responsibilities, package layout, shared-types strategy, data flow |
| `02-enlistment.md` | Config, registration, the `/almadel` commands, env-var join |
| `03-tools.md` | `almadel_move` / `_comment` / `_ask` / `_read` — the agent-facing surface |
| `04-job-loop.md` | Long-poll claim, the job union, dispatch, git/branch handling |
| `05-blocking.md` | The permission hook and the hybrid ask loop |
| `06-events.md` | Observing and pushing session events upward |
| `07-failures-testing.md` | Failure matrix (plugin subset), test strategy, the day-one spike |
| `08-open-questions.md` | Open decisions (§17) and plugin-local unknowns to pin |
| `09-spike-results.md` | **Spike output**: the permission surface on opencode 1.18.30 |

## Non-negotiables (from vision.md)

These are decisions already made; the plan assumes them and does not re-litigate
them. Violating any of them is a design regression, not an implementation detail.

1. **The plugin is the worker, in-process** (§2.1). No outboard supervisor.
2. **Fixed slot directories, branches not worktrees** (§2.2). A slot is a
   checkout; per-ticket isolation is `git checkout -b run/TCK-412`.
3. **Agents dial out; the server never dials in** (§2.3). Long-poll = heartbeat.
4. **All state lives in the ticket** (§2.4). The plugin writes progress back;
   it never holds durable state of its own.
5. **Projects are the namespace, not a filter** (§2.5). Enforced in the claim
   query *and* re-verified by the plugin on receipt.
6. **Plugin tools are the only path** (§2.8). No curl fallback, no skill file.
7. **TypeScript on Bun, everywhere** (§2.9). One zod schema for the job union,
   telemetry, and event payloads, shared with server and frontend.
8. **Enlistment is per-process and never persisted** (§2.11). No dotfile, no
   `.almadel.json`, nothing ambient in a directory. Intent is expressed only via
   `/almadel join` (interactive) or `ALMADEL_JOIN`/`ALMADEL_TOKEN` (unattended).
9. **Never `git checkout -f`** (§14). A dirty slot fails loudly.

## Build order

The plugin's work maps onto the vision's phases (§15). Plugin-relevant scope per
phase:

- **Spike (before Phase 1) — DONE.** The permission hook does not fire on
  opencode 1.18.30; the working surface is the `event` hook + the permission
  reply endpoint. See `09-spike-results.md`.
- **Phase 1 — boring path:** `/almadel join` / `status` / `leave`; long-poll
  claim; checkout; dispatch; `almadel_move` + `almadel_comment`. One project,
  one agent, no streaming, no blocking. A ticket goes in, a branch comes out.
- **Phase 2 — visibility:** event push, batching, sequencing, cancel job.
- **Phase 3 — ask loop:** `almadel_ask` (hybrid timeout), blocked states, reply
  injection, permission hook routing. The differentiator.
- **Phase 4 — multi-project/multi-agent:** join tokens, port bands, WIP limits,
  lease-expiry requeue (mostly server-side; plugin touches registration payload
  and `PORT_BASE` handling).
- **Phase 5 — packaging:** `bun build --compile` compatibility, npm publish,
  `init` one-liner that edits `opencode.json`.

## Source of truth

Everything below is derived from `../../vision.md`. Section references
(e.g. §9.1) point back into that document. Where this plan makes an assumption,
it is called out explicitly under "Open questions" (`08-open-questions.md`).

## Current status

Nothing exists yet. This plan is the first artifact. The immediate next action
is the permission-hook spike, because §12.2 is explicit that the entire
architecture's advantage over the old design depends on it.
