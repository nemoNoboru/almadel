# 08 — Open questions

Unresolved decisions from vision §17 that shape or block the plugin build. Each is
owned by someone (server, plugin, or both) and should be settled before the phase
that depends on it.

| # | Question (§17) | Plugin impact | Owner | Blocks |
|---|----------------|---------------|-------|--------|
| 1 | Does a blocked agent hold its slot? | Whether the poll loop keeps claiming while a ticket is `blocked_*`. Indefinite hold = simpler; claim-while-blocked = better utilisation but far more session state. | server + plugin | Phase 3 |
| 2 | Where do PRs happen — `gh pr create`, or Almadel on move-to-review? | Whether the plugin/slot needs git/GH credentials and a push token in the agent's environment. Keeping PRs out of the agent means the plugin doesn't hold credentials (§16). | server + plugin | Phase 1 end |
| 3 | Multiple slots per machine: two checkouts/two instances, or one instance with sessions? | The plugin assumes one slot per process and one fixed directory (§2.2). Sessions-in-one-instance breaks that assumption. | plugin | Phase 4 |
| 4 | Secrets: scoped short-lived tokens per project vs. a PAT. | Whether the agent's environment ever holds a credential; interacts with #2 and the permission "escalates" set (§12.4). | server | Phase 4 |
| 5 | Prompt versioning — snapshot the rendered prompt on the ticket at dispatch? | The plugin must send whatever it receives verbatim and never cache it; snapshotting is a server concern, but the plugin must not assume prompts are stable across registrations. | server | Phase 3 |
| 6 | Who reviews? (the unsolved bottleneck) | Diff review is the part this design is weakest on (§18); not a plugin code path yet, but the `run/*` branch hygiene and "leave branch in place for review" behaviour are the plugin's contribution to it. | both | Phase 4+ |

## Resolved by the spike (`09-spike-results.md`)

- **Permission surface** (was §12.2's open risk): the `permission.ask` hook and
  `permission.hook("evaluate")` are dead on 1.18.30; use the `event` hook +
  `client.postSessionIdPermissionsPermissionId(...)`. Pin opencode ≥ 1.18.30.
- **Client session-drive surface**: `client.session.{create,prompt,promptAsync,
  shell,messages,status,abort,…}` confirmed from source; full method list in the
  spike doc.

## New open questions from the spike

- **Worker launch mode.** `opencode run` auto-rejects (or `--auto`-approves)
  permissions in its own event loop, so the unattended worker cannot hold a
  permission open there. Confirm that `opencode serve` + plugin-driven
  `client.session.promptAsync` keeps a permission pending until the plugin
  replies — this was not exercised end-to-end in the spike. Owns: plugin. Blocks:
  Phase 3 permission delivery.
- **SDK/type drift.** The pinned `@opencode-ai/plugin@1.14.24` types are stale
  vs the 1.18.30 runtime. Decide whether to vendor the corrected types, upgrade
  the pinned SDK, or type the plugin loosely at the opencode boundary. Owns:
  plugin. Blocks: Phase 1 scaffolding.

## Additional plugin-local decisions to make

These aren't in §17 but fall out of the plugin's scope and should be pinned early:

- **Command registration.** The API behind `/almadel` and how it exposes
  `/almadel status` output in-session. Pin during Phase 1 (not covered by the
  spike).
- **Tool-result for `almadel_move`.** When a move ends the stage and closes the
  session, what does the tool return so the model stops cleanly? (The move is a
  terminal tool call for that stage; its result should signal "stage complete,
  stop".)
- **`almadel_read` cost.** A full thread read is cheap now but unbounded as
  comments grow; decide whether to cap/truncate before it matters.
