# 09 — Spike results: the permission surface on opencode 1.18.30

**Date:** 2026-09-11 · **Run against:** opencode `1.18.30` (installed binary at
`~/.opencode/bin/opencode`) · **Pinned plugin SDK in this checkout:**
`@opencode-ai/plugin@1.14.24` / `@opencode-ai/sdk@1.14.24`.

This spike resolves the day-one risk in vision §12.2 and `07-failures-testing.md`:
which permission surface actually fires, and can the plugin change the effect?

## Verdict (one paragraph)

The `permission.ask` plugin hook and the `permission.hook("evaluate")` v2 surface
are **both dead on 1.18.30**. Permissions are raised as **bus events**
(`permission.asked` / `permission.replied`) that the plugin receives through the
generic **`event` hook**, and the plugin resolves them by calling
**`client.postSessionIdPermissionsPermissionId(...)`** — exactly the "fallback
pattern" §12.2 predicted. This was proven end-to-end: a real permission was
raised, the plugin replied, and the turn resumed.

## What was tested and how

Three independent lines of evidence, listed strongest-first:

1. **Empirical (live binary).** A throwaway plugin registered both the
   `permission.ask` hook and the `event` hook, then a `deepseek-v4-pro` model
   (reachable via the global config) was asked to run a bash command with
   `permission: { bash: "ask" }` in the project config. Result:
   - `permission.asked` arrived in the `event` hook (full payload captured).
   - The plugin replied via `client.postSessionIdPermissionsPermissionId(...)`
     → `{"data":true}`.
   - `permission.replied` (`reply:"once"`) followed; the command then executed.
   - `permission.ask` hook **never fired**.

2. **Source (v1.18.30 tag, exact installed version).**
   `packages/opencode/src/permission/index.ts` publishes
   `Event.Asked`/`Event.Replied` through `EventV2Bridge` and awaits a `Deferred`;
   it never calls a plugin hook. `packages/opencode/src/plugin/index.ts`
   dispatches the `event` hook via `events.listen(...)` and dispatches only
   `tool.execute.before/after`, `chat.message`, `command.execute.before`,
   `experimental.chat.messages.transform`, etc. — no `permission.ask`.

3. **Binary (installed 1.18.30).** `strings` on the compiled binary:
   `"permission.asked"` ×21 and `"permission.replied"` ×14 (active bus events);
   the dispatchable hook key `"permission.ask"` ×0. `permission.hook` and
   `permission.updated` do not occur at all.

## The working surface (build against this)

### Event payload — `permission.asked`

The `event` hook's `event.properties` for a permission request is the
`PermissionRequest` shape (NOT the stale SDK `Permission` type):

```ts
{
  id: string            // "per_0908…"
  sessionID: string
  permission: string    // "bash" | "edit" | "webfetch" | …
  patterns: string[]    // e.g. ["echo x > /tmp/y"]
  metadata: Record<string, unknown>   // e.g. { command: "echo x > /tmp/y" }
  always: string[]      // patterns to persist if the human says "always"
  tool?: { messageID: string; callID: string }
}
```

### Reply

```ts
await client.postSessionIdPermissionsPermissionId({
  path: { id: sessionID, permissionID: permission.id },
  body: { response: "once" | "always" | "reject" },
});
// → POST /session/{id}/permissions/{permissionID}  →  { data: true }
```

### The plugin's `client` (v1 `OpencodeClient`)

Namespaces present at runtime: `global, project, pty, config, tool, instance,
path, vcs, session, command, provider, find, file, app, mcp, lsp, formatter,
tui, auth, event`.

**There is no `client.permission` and no `client.question` namespace** — the
1.14.24 SDK's `client.permission.list()` does not exist at runtime. The
permission reply is a method on the client root (`postSessionIdPermissionsPermissionId`).

Useful for the plugin's other responsibilities:
- `client.session.{create, prompt, promptAsync, shell, messages, status, abort, …}` — drive the session (dispatch.ts).
- `client.event.subscribe()` — raw SSE stream, an alternative to the `event` hook.
- `client.global`, `client.app`, `client.vcs`, … — auxiliary.

### The `event` hook's event types

Confirmed empirically (session + permission): `session.created`, `session.updated`,
`session.status`, `session.diff`, `session.idle`, `session.error`,
`permission.asked`, `permission.replied`. Present in source / the shipped herdr
plugin and inferred to fire likewise: `question.asked`, `question.replied`,
`question.rejected`, `tool.execute.before`, `tool.execute.after`, `message.*`.

## SDK type mismatch (1.14.24 vs 1.18.30 runtime) — must fix

The pinned `@opencode-ai/plugin@1.14.24` type definitions are stale. Do not trust:

| SDK 1.14.24 says | 1.18.30 runtime actually is |
|---|---|
| `Permission` = `{ id, type, pattern, sessionID, messageID, callID, title, metadata, time }` | `PermissionRequest` = `{ id, sessionID, permission, patterns, metadata, always, tool? }` |
| event type `permission.updated` | event type `permission.asked` |
| `client.permission.list()` | no `permission` namespace; `client.postSessionIdPermissionsPermissionId(...)` |
| hook `permission.ask` `(input, {status})` fires | hook is dead |

The plugin must be typed against the 1.18.30 shapes (captured above), not the
1.14.24 `.d.ts`.

## Critical design implication: launch mode decides whether a permission can be held open

The permission *reply* works, but whether the plugin can **hold a permission open
for a human** (the whole point of §12) depends on how opencode is launched.

`opencode run` (the headless CLI) has its own event loop that auto-resolves
permissions on `permission.asked` (source: `packages/opencode/src/cli/cmd/run.ts`
≈L801–820):

- `--auto` / `--yolo` / `--dangerously-skip-permissions` → auto-**allow** (`reply:"once"`).
- otherwise → **auto-reject** (`reply:"reject"`), printed as `permission requested: …; auto-rejecting`.

Observed live: the CLI's auto-reject races the plugin's reply. In the test the
plugin's `once` won (it fired in ~6 ms), but a plugin that *waits for a human*
would lose to the auto-reject.

**Consequence for the Almadel plugin:**
- The **interactive** path (a human runs `opencode` TUI in the slot) is fine —
  the TUI footer holds the permission, the plugin's `event` hook observes it.
- The **unattended** worker must **not** use `opencode run`. It should run
  `opencode serve` (headless server) and have the plugin drive sessions itself
  via `client.session.promptAsync`; there is no CLI auto-reject loop on that
  path, so a permission stays pending until the plugin replies with the human's
  decision.

This is a real change to the dispatch design (§11 / `04-job-loop.md`): the
plugin owns session creation and prompting, and `opencode run` is not the worker
entrypoint. Verify the serve-path assumption in the Phase-3 build (it was not
fully exercised here — the plugin does not load under a bare `opencode serve`
until a project is instantiated, and driving that path end-to-end is follow-up
work).

## Version-pinning recommendation

Pin **opencode ≥ 1.18.30** and build against the shapes in this document. Re-run
this spike on upgrade: the permission surface has a documented rocky history
(§12.2), and the `permission.ask` hook may be wired in a later release — if it
ever fires, the in-process block (§12.2's original design) becomes possible and
the fallback becomes unnecessary.

## Artifacts

Throwaway spike code and logs live under `/tmp/opencode/spike-project/` and
`/tmp/opencode/{spike,serve-spike}.log`. They are not part of the deliverable.
