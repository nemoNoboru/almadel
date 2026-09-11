# 07 — Failures, testing, and the day-one spike

## Failure matrix (plugin subset of §14)

| Failure | Detection | Plugin response |
|---------|-----------|-----------------|
| Wrong-project job | `job.project !== config.project` | Error comment, no checkout, no prompt (§3.1) |
| opencode too old for tools | Capability check at registration | Server refuses with 409; plugin surfaces the message (§9.2) |
| Registration mismatch | `git_remote` differs | Server refuses; plugin surfaces it (§3.2) |
| Dirty slot directory | `git checkout` fails | Fail the ticket with the git error; **never `-f`** (§14) |
| Server unreachable after join | Poll fails | Retry with backoff, keep the enlistment; `/almadel status` shows disconnected |
| Server restarts | Poll fails then recovers | Nothing to do — poll is stateless |
| Interactive agent crashes | Poll stops | Lease expiry requeues the ticket (server); slot stays gone until someone rejoins (§2.11) |
| Unattended agent crashes | Poll stops | systemd restarts; env vars rejoin automatically |
| `almadel_ask` times out | 5 min, no answer | Mark deferred, agent ends turn, resume by injection (§12.6) |
| Permission unanswered | Pending >1h | Server auto-denies (§12.5) |
| Push fails | HTTP error | Buffer and keep going; the run matters, log display doesn't (§8) |

The plugin's own invariants:

- **No persistence.** A crash loses `state.ts` (server URL, agent id, pending
  questions) and that's fine — the ticket is the database, the server requeues
  on lease expiry.
- **Never `git checkout -f`.**
- **Never write a dotfile** — no `.almadel.json`, nothing to gitignore.
- **Token never in a prompt or a file** — it lives only in the plugin's closure.

## Test strategy

The package is TypeScript on Bun; tests use `bun test` (or the repo's chosen
runner) plus a fake HTTP client for the server boundary.

### Unit

- `zod` schemas: valid/invalid job payloads, tool args (esp. `almadel_move`'s
  `z.enum` rejecting off-board columns), comment `kind` union.
- `config.ts`: project never inferred from remote; env-var parsing
  (`ALMADEL_JOIN` present but `ALMADEL_TOKEN` absent → dormant).
- `events.ts`: filter (only the six kinds), batch (250ms/4KB), immediate flush
  for permission/error/idle, buffer-on-failure never throwing.
- `permission.ts` auto-policy matcher: reads never escalate; pre-approved set;
  escalate set.
- `ask.ts` fast/slow split: answer within timeout → tool returns text; timeout →
  marks deferred and returns the stop instruction.
- `git.ts`: checkout failure on dirty dir → fail ticket, assert `-f` never
  invoked (mock the git runner).

### Integration (against a running `almadel` server)

- Join → slot appears; claim → task; move → next column; leave → requeue.
- Project-mismatch job → error comment, no checkout.
- End-to-end ask: `almadel_ask` → question row → human reply → tool resolves.

### The day-one spike (§12.2, §15) — DONE

**Result: on opencode 1.18.30 the `permission.ask` hook and
`permission.hook("evaluate")` are both dead.** The working mechanism is the
generic `event` hook receiving `permission.asked` / `permission.replied` bus
events, plus the `client.postSessionIdPermissionsPermissionId(...)` reply
endpoint — proven end-to-end. Full findings in `09-spike-results.md`.

The architectural risk §2.1 warned about is real: there is no in-process
permission hook to block on, so permission delivery is the fallback pattern.
This is workable but changes the dispatch design — the unattended worker must
not use `opencode run` (whose CLI auto-rejects permissions); it drives sessions
itself via `client.session.promptAsync` under `opencode serve`.

Still to pin during Phase 1 (not part of this spike): the command-registration
API behind `/almadel`, and the `client` session-drive surface in the serve path
(create session / send prompt / inject reply) — the shapes were catalogued from
source but not exercised under `opencode serve`.

## What "done" looks like per phase

- **Phase 1:** ticket in → branch out, via a real join and a real move. One
  project, one agent, no streaming, no blocking.
- **Phase 2:** live log pane populates from pushed, batched, sequenced events;
  cancel works.
- **Phase 3:** `almadel_ask` fast and slow paths both deliver; permission
  allow/deny resumes the turn in-process; amber badge is sub-second.
- **Phase 4:** join token on the command; port band surfaces via `{{port_base}}`;
  restarts reuse the slot row.
- **Phase 5:** `bunx @almadel/opencode-plugin init` edits `opencode.json`;
  `bun build --compile` still produces a working plugin; npm publish for both
  packages.
