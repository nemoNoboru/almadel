# 01 — Architecture

## Responsibilities (vision §9)

The plugin's nine jobs, verbatim from the vision:

1. On load: register the `/almadel` command and stay dormant — unless
   `ALMADEL_JOIN` is set, in which case join immediately.
2. On `/almadel join`: register with the server, bound to a project. Write
   nothing to disk.
3. Register the `almadel_*` tools, closed over ticket and project state.
4. Long-poll for jobs; verify `project` on every one.
5. On `task`: checkout the branch, create a session, send the rendered prompt.
6. On `reply`: resolve a pending `almadel_ask`, or inject into the session if
   the tool already timed out.
7. On `permission`: resolve the pending permission (reply via the client).
8. Observe events; push a filtered batch upward.
9. On the permission request: forward it to the server and await a decision.

## Package layout

```
@almadel/opencode-plugin/
├── package.json            # deps: opencode (peer), zod, shared-types
├── tsconfig.json
├── src/
│   ├── index.ts            # AlmadelPlugin entry: ({ client, directory }) => Plugin
│   ├── config.ts           # loadConfig(directory) + env parsing + validation
│   ├── register.ts         # POST /api/agents, capability check, payload build
│   ├── commands.ts         # /almadel join | status | leave
│   ├── tools.ts            # makeTools(agent) → almadel_* tool defs
│   ├── jobs.ts             # poll loop + Job union dispatch
│   ├── dispatch.ts         # checkout branch, create session, send prompt
│   ├── git.ts              # checkout/cleanup/branch hygiene (no -f)
│   ├── ask.ts              # almadel_ask hybrid fast/slow paths
│   ├── permission.ts       # event-hook permission handling + reply (see 05)
│   ├── events.ts           # event observer: filter/batch/buffer/push/sequence
│   ├── client.ts           # typed HTTP client to the server (holds token)
│   └── state.ts            # in-memory agent/session/ticket state (never persisted)
└── tests/
    ├── unit/               # zod schemas, filters, batching, auto-policy
    └── integration/        # against a running `almadel` server (fake client where useful)
```

`state.ts` holds the plugin's *only* mutable state: server URL, agent id, current
project, current ticket, current session, and the map of pending
questions/permissions. All of it is in-memory and dies with the process. The
ticket is the database (§2.4); the plugin is stateless across restarts.

## The opencode plugin interface

From vision §9, corrected by the spike (`09-spike-results.md`):

```ts
export const AlmadelPlugin: Plugin = async ({ client, directory }) => {
  const cfg = await loadConfig(directory);
  const agent = await register(cfg);
  poll(agent, client);            // background loop

  return {
    tool: makeTools(agent),       // almadel_move / _comment / _ask / _read
    event: onEvent(agent),        // permission.asked/replied + session + tool events
  };
};
```

The `permission: { evaluate }` hook in the vision §9 sketch **does not exist on
opencode 1.18.30**, nor does `permission.hook("evaluate")`. Permissions are
handled entirely through the `event` hook plus
`client.postSessionIdPermissionsPermissionId(...)`. See `05-blocking.md` and
`09-spike-results.md`.

Two handles matter:

- **`client`** — a handle to the plugin's own opencode server, used both to
  observe events (for push) and to drive the session (create session, send
  prompt, inject replies). At 1.18.30 it is the v1 `OpencodeClient`; its
  namespaces and the permission-reply method are catalogued in
  `09-spike-results.md`.
- **`directory`** — the slot's fixed working directory. This is how the plugin
  knows its repo root for registration (§3.2) and where to run git.

The command-registration API behind `/almadel` still needs pinning during
Phase 1 — it was outside the spike's scope.

## Shared types

Vision §2.9: one zod schema for the job union, telemetry, and event payloads,
"imported by server, plugin and frontend." The plugin cannot reach into the
server's private source and the server cannot depend on the plugin package, so
the shared schema needs a home. Recommended: a third workspace package
`@almadel/shared` (types + zod schemas only, no runtime logic), consumed by
`almadel`, `@almadel/opencode-plugin`, and the embedded UI. The decision belongs
to the repo scaffold but must be settled before either package is written.

What lives in `@almadel/shared`:

- `Job` union (task / reply / permission / cancel) — see `04-job-loop.md`
- `Registration` payload (§3.2)
- `Telemetry` (claim body: project, agent, slot status)
- `Event` payload shapes (assistant text, tool call, tool result, permission,
  session idle, error)
- `Scope` (`once | always | session`), `Decision` (`allow | deny`)
- Comment `kind` union (`comment | plan | question | answer | permission | move`)

## Data flow

```
                      ┌─────────────── almadel server ───────────────┐
                      │  POST /api/claim  (long poll, 35s)           │
        ┌────────────▶│  POST /api/agents (register)                 │
        │  jobs       │  POST /api/tickets/{id}/events (push)        │
        │  (pull)     │  POST /api/tickets/{id}/permission-request   │
        │             └──────────────────────────────────────────────┘
        │                          ▲
┌───────┴──────────────────────────┴──────────┐
│  opencode process                           │
│  + almadel plugin                           │
│    - poll loop (jobs.ts)                    │
│    - tools (tools.ts) → move/comment/ask    │
│    - event hook (events.ts + permission.ts) │
│    - session driver (dispatch.ts)           │
│    - git (git.ts) in `directory`            │
└─────────────────────────────────────────────┘
```

Key property: **the plugin both pulls (claim) and pushes (events/requests)**,
but every request carries the registration token; the agent's prompt never sees
a URL, a ticket id, or a token (§2.8).

## Two independent loops

The plugin runs two background loops that must not share mutable state without
care:

1. **Job loop** — `poll()` long-polls `/api/claim`, handles the `Job` union. It
   is the only thing that creates sessions and dispatches work.
2. **Event loop** — the `event` hook receives session events; it filters, batches,
   pushes them upward, and (in `permission.ts`) reacts to `permission.asked`.
   It never blocks the session.

They communicate only through `state.ts` (e.g., the event hook reads the current
ticket to tag events; the job loop flips status when a turn starts/ends).

## Concurrency rule (inherited from §2.9)

`bun:sqlite` is a server concern, but the same discipline applies to plugin-side
state: **never `await` while holding an invariant that must be atomic.** The
relevant plugin example is the ask loop — a pending `almadel_ask` must be
associated with its question id before the long poll starts, otherwise a fast
reply can arrive before the plugin is listening.
