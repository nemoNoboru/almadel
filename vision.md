# Almadel

*A kanban board where the columns are prompts, and the agents are opencode instances that joined by URL.*

> **v2.** Rewritten around the plugin architecture. The previous version had a
> standalone Go worker that drove opencode over HTTP and scraped its SSE stream.
> That's gone: the worker is now an opencode plugin, which makes permission
> handling synchronous and in-process instead of inferred from outside.
> Projects are now the top-level namespace.

---

## 1. Vision

Almadel is a self-hosted control plane for coding agents. You write a ticket, drop it in a column, and an agent somewhere picks it up, does the work on its own branch, and moves the card forward. If it gets stuck — or hits a command it isn't allowed to run — it asks you in a chat panel and waits.

Two bets carry the design.

**Column-as-prompt.** The board is not a view of the work, it *is* the workflow definition. A column with a prompt attached is an agent stage; a column without one is a human gate. Adding a review step means dragging a column into place, not editing a pipeline. This also splits one long, unreviewable agent run into `Spec → Plan → Implement → Test`, where each stage starts with fresh context and produces an artifact you read before the next one fires.

**Joining is a command.** An agent doesn't get deployed, it enlists — deliberately, by typing `/almadel join <server>` in its own opencode. No binary to distribute, no ports to open, no tunnel, and no instance becomes a worker without someone saying so.

### Non-goals

- Not a hosted product. Self-hosted, single-tenant, one team.
- Not a general workflow engine. Coding tasks against git repos.
- Not agent-agnostic. The permission design is specific to opencode (§12).
- Not horizontally scalable on the server. One process, one SQLite file.

### What already exists

This category filled in fast, and some of it overlaps hard. Docker Agent Board already ships column-as-prompt. Cline Kanban already ships the board, worktrees, parallel agents and diff review. See §18 — the honest remaining ground is the ask loop and remote enlistment, not the board itself.

### The name

*Almadel* (Ars Almadel, 4th book of the Lemegeton) is a small wax tablet you assemble on demand, use to summon an entity that does work for you, then take down. Four altitudes, four candles. Close enough. Nobody can spell it.

---

## 2. Core design decisions

### 2.1 The worker is an opencode plugin, not a process

Earlier design: a supervisor binary that started opencode, drove it over HTTP, and watched its SSE event stream to figure out what was happening. The fatal problem was permissions — opencode pauses mid-turn awaiting approval, nobody is notified, and a supervisor blocked on `send_message` never gets its response back. You end up inferring internal state from outside the process.

A plugin lives inside. It gets a `client` handle to its own server, so it can both observe and drive the session. Permission handling becomes a synchronous in-process decision (§12). Event forwarding becomes a direct push instead of a scrape.

**Cost:** the plugin can't start, restart, or kill its own process, and can't enforce resource limits. That's acceptable for your own agents; it wouldn't be for someone else's.

### 2.2 Fixed slot directories, branches not worktrees

Falls directly out of 2.1. A plugin can't create a worktree and re-anchor its own process into it — opencode is already running in a directory when the plugin loads. So a slot is a **fixed checkout**, and per-ticket isolation is `git checkout -b run/TCK-412` inside it.

This is a downgrade in theory and an upgrade in practice. Reported pain with worktree-per-ticket tools is twenty stale worktree folders bloating disk and confusing `find`. A fixed slot dir keeps `node_modules` warm across tickets and has no cleanup problem.

Isolation still holds: two slots are two directories, two checkouts, two branches.

### 2.3 Agents dial out; the server never dials in

The server is purely an HTTP server. Plugins long-poll it for work, push events to it, and call it on the agent's behalf when a tool fires.

A laptop behind NAT can join a hosted Almadel with no tunnel. It also means the poll doubles as the heartbeat — an agent that's alive is polling.

### 2.4 All state lives in the ticket

If progress only exists in a running process, a crash loses it and you can't inspect or intervene. Plans, questions, answers, branch names, comments — all written back to the ticket. The board is the database, and it's one you can operate by hand.

### 2.5 Projects are the namespace, not a filter

Slots, boards, columns and tickets all belong to exactly one project. This is a correctness boundary, not a UI convenience: a ticket that reaches a slot checked out on the wrong repo doesn't fail, it produces plausible code in the wrong codebase. Scoping is enforced in the claim query *and* re-verified by the plugin on receipt (§3).

### 2.6 Agent moves are semantic; server moves are guaranteed

Only the agent knows whether it finished planning or got stuck, so it can move its own ticket. But a transition that only happens if an LLM remembers to call a tool sometimes doesn't happen. On session idle with the ticket still in-flight, the server moves it by outcome. Agent moves make the board expressive; server moves make it correct.

### 2.7 Blocking happens inside a tool call, with a timeout

The agent calls `almadel_ask`. The tool **does not return** — it posts the question and awaits your answer, which then arrives as the tool result. The agent continues mid-turn with its full context intact. Same mechanism as the permission hook (§12).

This is much stronger than telling the agent to stop and wait and injecting a reply later, which relied on the model actually ending its turn when instructed — something it doesn't reliably do.

But a pending tool call can't survive an opencode restart and may hit an execution timeout, so long blocks can't live inside one. Hence a hybrid: **block in-tool for a few minutes, then fall back to ending the turn and resuming by message injection.** Fast path covers "you're at your desk and answer in thirty seconds"; slow path covers overnight.

### 2.8 Plugin tools are the only path

The plugin registers real tools — `almadel_move`, `almadel_comment`, `almadel_ask`, `almadel_read` — and the agent gets them as first-class calls. There is **no curl fallback**.

This was previously rejected on the grounds that MCP wasn't worth an extra process. The plugin makes it free:

- **The agent can't get the ticket ID or URL wrong**, because it never sees them — they live in the plugin's closure, not in prompt text where a long session drifts or a second ticket inherits a stale value.
- **Schema-validated arguments** instead of hand-assembled JSON in a curl body.
- **Endpoints can require authentication.** With curl, anything that could read the prompt could move tickets. Now the plugin calls them holding a registration token the agent never sees.
- **Structured events for the UI** — a tool call is typed, not an opaque bash invocation you'd parse to detect a move.
- **Works with bash disabled.**

A fallback skill was considered and rejected: two code paths for four operations, where the rarely-used one is the less-tested one, and every bug report starts with "which path was it on?". More to the point, a fallback was never coherent — the plugin is what long-polls for work, so an opencode without it never receives a ticket to act on in the first place. There was nothing to fall back *to*.

### 2.9 TypeScript on Bun, everywhere

The plugin must be JS. Making the server JS too means one `zod` schema for the job union, telemetry, and event payloads, imported by server, plugin and frontend — instead of hand-syncing types across a language boundary.

Bun also resolves the concurrency problem that drove earlier language choices. Long polls are pending promises, not blocked threads. `bun:sqlite` is synchronous, so a claim transaction runs to completion without yielding the event loop — atomic claiming with no locking. **The one rule: never `await` inside the claim transaction.**

`bun build --compile` still produces a single self-contained executable if you want one.

### 2.10 Two packages

| Package | Installed by | Contains |
|---|---|---|
| `almadel` | whoever runs the board | server, UI, SQLite, CLI |
| `@almadel/opencode-plugin` | every agent machine | plugin, tools, config snippet |

Worker machines never install the server. Dragging SQLite and the board onto a laptop that only needs to speak to it is the kind of thing that makes people not join.

### 2.11 Enlistment is per-process and never persisted

Installing the plugin does **not** make an instance a worker. Loading it registers an `/almadel` command and nothing else. The instance stays dormant until intent is expressed *for that process*, and it forgets when the process dies.

Two footguns motivate this. `opencode.json` is usually committed, so a plugin that registered on load would enlist every teammate who opens the repo. And persisted enlistment has a slower version of the same failure: you join, work for a week, and two months later open opencode in that directory for an unrelated reason and it silently starts claiming tickets on a decision you no longer remember making.

So there is **no `.almadel.json`, no remembered state, nothing ambient in a directory**. Intent is expressed exactly two ways, both at launch time:

| | How intent is expressed | Who expresses it |
|---|---|---|
| Interactive | `/almadel join <server>` typed in the session | the person, now |
| Unattended | `ALMADEL_JOIN` / `ALMADEL_TOKEN` in the environment | whoever wrote the unit file |

The second keeps §9.3's `Restart=always` working without reintroducing stickiness: a dedicated worker rejoins on restart because its launcher says to, and that's visible in `systemctl cat`. Start opencode by hand in the same directory with no env var and you get a normal session.

The cost is real and accepted: an interactive agent that crashes does not come back, and its slot disappears from the board until someone rejoins. Lease expiry (§14) requeues whatever it held, so nothing is lost — you just have one fewer agent until you notice.

---

## 3. Projects

A project is a repo plus a board. Everything else hangs off it.

```
project: almadel-api
  ├── columns    (its own pipeline)
  ├── tickets    (its own backlog)
  └── slots      (agents checked out on this repo)
```

### 3.1 Why this is a correctness boundary

An agent is a real checkout on a real machine. If a ticket for `almadel-web` reaches a slot sitting in `almadel-api`, the agent doesn't error — it reads an unfamiliar codebase, decides the files must be elsewhere, and writes something. You get a branch of confident nonsense in the wrong repo, and you find out at review.

So scoping is enforced twice:

**In the claim.** The query filters by project, always. There is no unscoped claim path.

```sql
SELECT * FROM tickets
WHERE project_id = ? AND state = 'ready'
ORDER BY priority DESC, created_at ASC LIMIT 1;
```

**On receipt.** The plugin re-checks before touching anything, because a server bug shouldn't be able to cause a wrong-repo write:

```ts
if (job.project !== config.project) {
  await reportError(job.ticket, "project mismatch");
  return; // do not check out, do not prompt
}
```

Defense in depth, four lines.

### 3.2 Binding an agent to a project

The plugin knows its own working directory, so registration declares the binding explicitly and the server sanity-checks it:

```json
{
  "project": "almadel-api",
  "repo_root": "/home/me/src/almadel-api",
  "git_remote": "git@github.com:me/almadel-api.git",
  "default_branch": "main",
  "label": "laptop"
}
```

Explicit `project` beats inferring from the remote — monorepos, forks and mirrors all break inference. But the server compares `git_remote` against the project's registered remote and **refuses registration on mismatch** rather than warning, since a warning in a log nobody reads is not a boundary.

One opencode instance is one slot in one project. Working on two projects means two checkouts and two instances, which is what you'd have anyway.

### 3.3 What's scoped and what isn't

| Scoped to project | Global |
|---|---|
| Board, columns, prompts | The roster sidebar (grouped by project) |
| Tickets, comments, branches | The **Needs you** count |
| Slots, claim queue | Your session and settings |
| Join tokens | Server config |

The "needs you" count is deliberately global: you want to know an agent is blocked whether or not you're currently looking at that project's board. Everything else is scoped, because seeing another project's tickets on this board is exactly the confusion this section exists to prevent.

### 3.4 Join tokens are per-project

`https://almadel.example.org/join?t=<token>` where the token names a project. A teammate joining gets an agent bound to that project and can't accidentally enlist against another. Tokens are revocable and scoped; there's no global join.

---

## 4. The board

### 4.1 Column configuration

Every column is a small config object, per project, editable from the UI:

```yaml
- name: Spec
  prompt: null                    # human gate — nothing auto-dispatches
  next: Planning

- name: Planning
  prompt: |
    Read ticket {{ticket.id}} and produce an implementation plan.
    Do not write code. Post the plan with kind="plan", then move to Review.
  next: Review
  fail: Failed
  wip_limit: 2

- name: Review
  prompt: null                    # human gate — you read the plan
  next: Implement

- name: Implement
  prompt: |
    Ticket {{ticket.id}}. The approved plan is in the thread below.
    Implement it on branch {{branch}}. Run the test suite before finishing.
    Dev servers must bind ports starting at {{port_base}}.
  next: Testing
  fail: Failed
```

`prompt: null` is the entire mechanism for a human gate. No separate concept of a manual step.

### 4.2 Prompt template variables

Rendered at dispatch, so the agent starts with everything and needs no fetch to begin:

| Variable | Contents |
|---|---|
| `{{ticket.id}}` | `TCK-412` |
| `{{ticket.title}}`, `{{ticket.body}}` | As written |
| `{{thread}}` | Full comment history, including prior stages' artifacts |
| `{{branch}}` | `run/TCK-412` |
| `{{project}}` | `almadel-api` |
| `{{port_base}}` | This slot's port band |

`{{thread}}` does the real work — it's how Implement sees the plan Planning wrote, without either stage sharing a session.

### 4.3 WIP limits

A column's `wip_limit` caps how many tickets that stage occupies at once, so a slow Implement stage can't starve Testing. The natural ceiling is total slots in that project. Sum of limits above total slots just means queueing.

### 4.4 Drag semantics

Dragging a card into a prompted column marks it `ready` and broadcasts on `notify`. Same path as an agent moving it. There's no run button — moving a card is running it. Dragging a `running` ticket out cancels it first.

---

## 5. The agent roster

A sidebar of agents with presence, grouped by project. Click one, get a conversation.

### 5.1 An agent is a slot, not a session

Sessions are ephemeral, created and destroyed per ticket, so a session-keyed contact list churns too fast to build any mental model of. A **slot** is stable: one opencode instance, one checkout, one project, present as long as it's polling. It works several tickets a day and occasionally needs you.

Display names help. Since the project is named after a grimoire, the Almadel's four altitudes come with their own angels — Alimiel, Gabriel, Barachiel, Gediel — which is more sayable than `laptop/2`.

### 5.2 Status model

| Status | Meaning | UI |
|---|---|---|
| `offline` | Hasn't polled in 90s | Greyed, no thread |
| `idle` | Free | Dim, no thread |
| `working` | Running a turn | Green, live log, compose queues |
| `blocked_question` | Called `/ask` | **Amber + badge**, compose box |
| `blocked_permission` | Paused awaiting approval | **Amber + badge**, allow/deny buttons |
| `failed` | Last run errored | Red, thread readable |

Two blocked flavours, deliberately distinct: a question wants prose, a permission wants a decision and shows the command. Sending free text to a permission-paused session does nothing useful.

### 5.3 Where status comes from

Two paths, with very different latencies, and it matters which is which.

**Detection is immediate**, via push. A question arrives the moment `almadel_ask` fires; a permission the moment the hook fires. In both cases the plugin POSTs it straight away — the server is told, not discovering. Sub-second.

**Telemetry is the backstop**, via the poll. Every claim carries current slot state:

```json
{ "project": "almadel-api", "agent": "agt_abc",
  "slot": { "status": "working", "ticket": "TCK-412", "since": 1757400000 } }
```

Up to 35s stale, so it can never drive the badge. Its job is reconciliation (§12.5): the plugin reports what it actually observes, and disagreement with stored state gets corrected.

### 5.4 Render the badge from a query, not an event count

If the badge is incremented by SSE events, a refresh or a dropped connection loses it. The stream only says *something changed, re-render*. The truth is:

```sql
SELECT count(*) FROM tickets WHERE state LIKE 'blocked%';
```

Open the UI cold after a weekend and the count is right, because it was never in the browser.

### 5.5 Talking to an agent

- **`blocked_question`** — your reply is injected into the existing session. Full context survives. This is the point of §2.7.
- **`blocked_permission`** — allow / deny, with a scope (once, always, session).
- **`working`** — compose accepts but stores as a **pending message**, delivered when the turn ends. A nudge, shown as queued so the delay isn't a surprise.
- **`idle` / `offline`** — read-only history.

Plus two fixed actions: **Cancel**, and **Take over** (mark human-owned, leave the branch checked out so you can open it yourself).

### 5.6 One thread, two views

The conversation is the ticket's `comments` rows — the same ones the card renders and `{{thread}}` inlines into the next stage's prompt. The roster is a lens keyed by who holds the ticket rather than by ticket.

Consequence worth being deliberate about: everything you say to an agent is permanently on the ticket and will be read by whichever agent runs the *next* stage. That's usually a feature — clarifications propagate forward — but the chat is not a side channel and the UI shouldn't imply it is.

### 5.7 Layout

```
┌─────────────┬──────────────────────────────────┬──────────────┐
│ almadel-api │  Spec  Planning  Review  Impl    │ Gediel       │
│ ● Alimiel   │  ┌───┐ ┌───┐    ┌───┐   ┌───┐    │ blocked      │
│   working   │  │412│ │418│    │405│   │399│    │ TCK-418      │
│ ▲ Gediel  1 │  └───┘ └───┘    └───┘   └───┘    │──────────────│
│   blocked   │                                  │ agent: which │
│             │                                  │ auth backend?│
│ almadel-web │                                  │              │
│ ○ Barachiel │                                  │ [ reply... ] │
│   idle      │                                  │              │
│─────────────│                                  │              │
│ Needs you 1 │                                  │              │
└─────────────┴──────────────────────────────────┴──────────────┘
```

Roster grouped by project; board shows the selected project only; `Needs you` spans all of them.

---

## 6. Architecture

```
                    ┌──────────────────────────┐
   browser ────────▶│  almadel (server)        │
   (HTMX/SSE)       │  Bun + bun:sqlite + UI   │
                    └────────▲─────────────────┘
                             │  long-poll claim      ─┐
                             │  push events          ─┤ all outbound
                             │  comment/move/ask     ─┘ from the agent side
              ┌──────────────┴───────────────┐
              │                              │
   ┌──────────┴──────────┐        ┌──────────┴──────────┐
   │ opencode            │        │ opencode            │
   │  + almadel plugin   │        │  + almadel plugin   │
   │  ~/src/almadel-api  │        │  ~/src/almadel-web  │
   │  project: api       │        │  project: web       │
   └─────────────────────┘        └─────────────────────┘
```

No separate worker process. The plugin is the worker, and it lives in the same process as the agent it manages. The server has no outbound connections at all.

---

## 7. Data model

```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,   -- almadel-api
  name          TEXT NOT NULL,
  git_remote    TEXT,               -- checked at registration
  default_branch TEXT DEFAULT 'main',
  created_at    INTEGER
);

CREATE TABLE columns (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  prompt      TEXT,               -- NULL = human gate
  next_column TEXT,
  fail_column TEXT,
  wip_limit   INTEGER
);

CREATE TABLE tickets (
  id          TEXT PRIMARY KEY,   -- TCK-412
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  body        TEXT,
  column_id   TEXT NOT NULL,
  state       TEXT NOT NULL,      -- ready | running | blocked_question
                                  -- | blocked_permission | done | failed
  branch      TEXT,
  agent_id    TEXT,
  priority    INTEGER DEFAULT 0,
  claimed_at  INTEGER,
  created_at  INTEGER
);
CREATE INDEX idx_claim ON tickets(project_id, state, priority, created_at);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  author     TEXT NOT NULL,       -- human | agent | system
  kind       TEXT NOT NULL,       -- comment | plan | question | answer
                                  -- | permission | move
  body       TEXT,
  created_at INTEGER
);

-- One row per slot, not per process: upserted on (project_id, repo_root, label)
-- so restarts reuse the row instead of leaving ghosts (§9.2).
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  name          TEXT,             -- "Gediel"
  label         TEXT,             -- "laptop"
  repo_root     TEXT,
  status        TEXT NOT NULL,
  ticket_id     TEXT,
  since         INTEGER,
  last_poll     INTEGER,
  opencode_version TEXT,           -- checked at join (§9.2)
  registered_at INTEGER
);

CREATE TABLE permissions (
  id          TEXT PRIMARY KEY,   -- prm_91, from opencode
  ticket_id   TEXT NOT NULL,
  tool        TEXT,
  command     TEXT,               -- shown in the UI
  decision    TEXT,               -- NULL until answered
  scope       TEXT,               -- once | always | session
  created_at  INTEGER,
  decided_at  INTEGER
);

CREATE TABLE questions (
  id         TEXT PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  answer     TEXT,
  deferred   INTEGER DEFAULT 0,   -- tool timed out; answer goes via injection
  created_at INTEGER,
  answered_at INTEGER
);

CREATE TABLE pending_messages (
  id         INTEGER PRIMARY KEY,
  ticket_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER,
  sent_at    INTEGER              -- NULL until delivered
);

CREATE TABLE events (
  ticket_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT,
  created_at INTEGER,
  PRIMARY KEY (ticket_id, seq)
);

CREATE TABLE join_tokens (
  token      TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  expires_at INTEGER,
  revoked    INTEGER DEFAULT 0
);
```

Presence is derived, never stored: an agent is online iff `last_poll` is fresh. Nothing writes `offline`.

Enable WAL for reader concurrency with the SSE endpoints. `bun:sqlite` is synchronous, so transactions are atomic by construction — provided nothing `await`s inside one.

---

## 8. API surface

### Agent-facing, from the plugin

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/agents` | Register. Body per §3.2. Returns agent id + name. |
| `DELETE` | `/api/agents/{id}` | Deregister on shutdown — requeues immediately. |
| `POST` | `/api/claim` | Long poll (35s). Carries telemetry; returns a job or 204. |
| `POST` | `/api/tickets/{id}/events` | Batched agent output, pushed up. |
| `POST` | `/api/tickets/{id}/permission-request` | A permission hook fired; blocks until decided. |

`/api/claim` returns a **union** — this is what makes blocked-resume work over a pull-only channel:

```ts
type Job =
  | { type: "task";       project: string; ticket: string; prompt: string; branch: string }
  | { type: "reply";      project: string; ticket: string; text: string }
  | { type: "permission"; project: string; ticket: string;
      permission_id: string; decision: "allow" | "deny"; scope: Scope }
  | { type: "cancel";     project: string; ticket: string };
```

New tickets, replies into held sessions, and permission decisions all arrive through one channel. Every job carries `project` so the plugin can re-verify (§3.1).

### Agent-facing tools (the primary path)

Registered by the plugin, so the agent never sees a URL or a ticket ID:

| Tool | Arguments | Behaviour |
|---|---|---|
| `almadel_comment` | `{ kind, body }` | Returns immediately |
| `almadel_move` | `{ column, note }` | Returns immediately; ends the stage |
| `almadel_ask` | `{ question }` | **Blocks**, resolves with your answer (§12.6) |
| `almadel_read` | `{}` | Returns the ticket and its thread |

All of them close over `ticket`, `project` and the server URL from the plugin's own state.

### Plugin-facing HTTP

What the tools call underneath. **Not agent-facing** — the agent never sees these URLs, and every one requires the agent's registration token, so a prompt-injected instruction to "POST to /move" has nothing to work with.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/tickets/{id}` | Ticket + thread |
| `POST` | `/api/tickets/{id}/comment` | Post a note or artifact |
| `POST` | `/api/tickets/{id}/move` | `{"column":"review","note":"..."}` |
| `POST` | `/api/tickets/{id}/ask` | Creates a question row; returns its id |
| `GET` | `/api/questions/{qid}` | Long poll for the answer (§12.6) |

Each is scoped to the ticket that token's agent currently holds. An agent cannot touch another agent's ticket even by id.

### Browser-facing

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/p/{project}` | Board |
| `GET` | `/join` | Enlistment page (§9.2) |
| `GET` | `/api/roster` | All projects, slots, `needs_you` count |
| `GET` | `/api/roster/stream` | SSE: presence and status changes |
| `GET` | `/api/tickets/{id}/stream` | SSE: replay from `events` at a `seq` offset |
| `POST` | `/api/tickets/{id}/reply` | Answer, or queue a nudge if busy |
| `POST` | `/api/tickets/{id}/permission` | allow / deny + scope |
| `POST` | `/api/tickets/{id}/cancel` | |
| `POST` | `/api/tickets/{id}/takeover` | Mark human-owned, leave the branch in place |
| `GET`/`PUT` | `/api/projects/{id}/columns` | Read and edit the pipeline |

The browser never talks to opencode. Anything that can drive that API can run arbitrary bash on the repo.

### Long poll

Broadcast on ticket creation rather than waking every second:

```ts
const job = await Promise.race([
  waitForNotify(projectId, agentId),
  sleep(35_000).then(() => null),
  request.signal.aborted,
]);
return job ? Response.json(job) : new Response(null, { status: 204 });
```

35s must sit under whatever your ingress kills idle connections at.

### Event push

The plugin pushes; the server never pulls. Rules:

- **Filter.** Assistant text, tool calls and results, permission requests, session idle, errors. Nothing else.
- **Batch** every ~250 ms or ~4 KB — but **permission, error and idle flush immediately**, because those are exactly the events that need to be fast.
- **Buffer** on failure and keep going. The run matters; log display doesn't.
- **Sequence per ticket**, so a reconnecting browser resumes at its last-seen offset.

---

## 9. The plugin

`@almadel/opencode-plugin`, declared in the project's `opencode.json`. Its responsibilities:

1. On load: register the `/almadel` command and stay dormant — unless `ALMADEL_JOIN` is set, in which case join immediately (§2.11).
2. On `/almadel join`: register with the server, bound to a project (§3.2). Write nothing to disk.
3. Register the `almadel_*` tools (§8), closed over ticket and project state.
4. Long-poll for jobs; verify `project` on every one.
5. On `task`: checkout the branch, create a session, send the rendered prompt.
6. On `reply`: resolve a pending `almadel_ask`, or inject into the session if the tool already timed out.
7. On `permission`: resolve the pending hook.
8. Observe events; push a filtered batch upward.
9. On the permission hook: call the server and await a decision (§12).

```ts
export const AlmadelPlugin: Plugin = async ({ client, directory }) => {
  const cfg = await loadConfig(directory);
  const agent = await register(cfg);
  poll(agent, client);            // background loop

  return {
    tool: makeTools(agent),       // almadel_move / _comment / _ask / _read
    permission: { evaluate: onPermission(agent) },
    event: onEvent(agent),
  };
};
```

### 9.1 Commands

| Command | Effect |
|---|---|
| `/almadel join <server> [--token t]` | Register and start polling, for this process only |
| `/almadel status` | Server, project, agent name, current ticket, connection state |
| `/almadel leave` | Deregister, requeue any held ticket, go dormant |

`status` earns its place — "am I actually connected, and to what?" is the first question when something looks wrong, and answering it inside opencode beats going to the board to find out.

`join` refuses if the current session already has history, with a message explaining that the instance becomes a worker and tickets will check out branches in this directory. `--force` overrides.

None of these persist anything. `leave` and quitting opencode are equivalent from the server's point of view — the difference is only that `leave` requeues immediately instead of waiting out the 90s lease.

### 9.2 Enlisting

Two steps, and they're deliberately different in kind: one installs code, one grants consent.

**1. Install the plugin.** `/join` serves a copy-pasteable one-liner:

```bash
bunx @almadel/opencode-plugin init
```

which adds the plugin to `opencode.json` and prints the next step. No server URL, no token — this step only puts code on the machine.

**2. Restart opencode, then join.** In the restarted instance:

```
/almadel join https://almadel.example.org --token <t>
```

The restart is what loads the plugin. Its own verification is built in: if `/almadel` doesn't autocomplete, the plugin didn't load, and the person finds that out immediately rather than from a board that never shows their agent.

Nothing registers until the command runs, so the `/join` page stays **pending** and ticks green over the roster SSE stream the moment it does.

**Why the token goes on the command, not in a file.** `opencode.json` gets committed. A token in it is a credential in git, and a server URL in it means every teammate who opens the repo enlists by opening it. Passing the token to `join` keeps the committed file free of both — and the plugin writes nothing back, so there's no dotfile to gitignore and no state to go stale (§2.11).

**Unattended workers** express the same intent through the environment instead:

```ini
# /etc/systemd/system/almadel-agent@.service
Environment=ALMADEL_JOIN=https://almadel.example.org
EnvironmentFile=/etc/almadel/token          # ALMADEL_TOKEN=...
WorkingDirectory=/srv/slots/%i
Restart=always
```

The plugin joins at load only when both are present. This is still explicit — a human wrote the unit, and `systemctl cat` shows exactly what it does — but it survives restarts, which an interactive join deliberately doesn't.

**Rejoining must not accumulate ghosts.** Since every process start is a fresh registration, a worker restarted ten times would leave ten dead rows in the roster. The server upserts on `(project_id, repo_root, label)` rather than inserting: same directory, same slot, new session. The agent id is regenerated, the display name is not — Gediel stays Gediel across restarts, which is the whole point of §5.1.

**The one case that needs a real check** is a plugin loading against an opencode too old to support tool registration or the permission hook. `join` therefore sends `opencode_version` and a capability flag, and the server **refuses** on either failing:

```
409  almadel requires opencode >= 1.x with plugin tool support.
     found 0.9.4 — upgrade and restart.
```

Refuse, don't degrade. An agent that can't call `almadel_move` can't finish a stage, so letting it register would just produce tickets that go in and never come out.

**Make the deterministic path primary.** It's tempting to serve `join.md` and tell people "point your agent at this URL" — but that makes an LLM your installer, produces slightly different config on every machine, and normalises "fetch a URL and do what it says," which is the exact injection shape you're containing elsewhere. An LLM also can't restart the process it's running inside, and can't consent on its owner's behalf. The page should stay readable to an agent, but the two steps above are the route.

### 9.3 What the plugin can't do

It can't start, restart, or kill its own process, and can't cap its own memory. Lifecycle is systemd with `Restart=always`, or a compose file with a restart policy — which is also where an unattended worker's join intent lives (§9.2). That's a unit file, not a program, but it is a real gap if you ever run untrusted tickets.

---

## 10. The tool contract

There is no skill file. Tool descriptions carry the "how", the column prompt carries the "what" (§4.1), and neither lives in a markdown file the agent could be talked out of following.

```ts
almadel_move: {
  description:
    "Finish the current stage and move this ticket to another column. " +
    "Call this exactly once, when your stage's work is complete. " +
    "Do not call it to report progress — use almadel_comment for that.",
  args: z.object({
    column: z.enum(columnsFor(agent.project)),   // not a free string
    note:   z.string().max(2000),
  }),
}

almadel_ask: {
  description:
    "Ask the human a question and wait for their answer. Use this when you " +
    "are blocked on a decision only they can make. The answer comes back as " +
    "this tool's result — do not stop and poll.",
  args: z.object({ question: z.string().min(1).max(4000) }),
}
```

Two things worth doing in the schema rather than in prose:

**Enumerate the columns.** `column` as a `z.enum` built from that project's actual board makes an invalid move structurally impossible, instead of a validation error the agent has to recover from.

**Say what each tool is *not* for.** The common failure is an agent calling `move` to report progress. One sentence in the description costs nothing.

Because the descriptions are generated from the project's board, editing a column in the UI updates what the agent sees on its next registration — the prompts stay editable without a package release, which is what the skill file was for.

---

## 11. Lifecycle of a ticket

1. **Create.** Human writes a card in a prompted column. `state=ready`. Server broadcasts on that project's `notify`.
2. **Claim.** A parked poll for that project wakes, claims atomically, returns `{type:"task"}`. `state=running`.
3. **Verify.** Plugin checks `job.project` against its own config. Mismatch → error comment, no checkout (§3.1).
4. **Prepare.** `git checkout -b run/TCK-412` in the slot directory.
5. **Dispatch.** Plugin creates a session and sends the rendered prompt — column template with title, body and full thread inlined.
6. **Work.** Agent edits, runs tests, calls `almadel_comment` as it goes. Plugin observes events and pushes filtered batches up; server fans out to browsers.
7. **Terminate**, one of:
   - Agent calls `almadel_move` → next column, session closed, slot recycled.
   - Agent calls `almadel_ask` → `blocked_question`, turn paused **inside the tool call** (§12.6).
   - Permission hook fires, no auto-rule → `blocked_permission`, turn paused in-process.
   - Session idle without a move → server fallback moves it by outcome.
   - Human cancels → `cancel` job on next poll.
8. **Resume.** Human answers → `reply` or `permission` job → plugin resolves the pending tool call or hook → agent continues mid-turn with full context. If the tool already timed out, the plugin injects the answer into the session instead (§12.6).
9. **Clean up.** Branch left in place for review; slot returns to the default branch.

---

## 12. Blocking and unblocking

Two things stop an agent, and only one involves the agent cooperating.

### 12.1 The two kinds

| | Question | Permission |
|---|---|---|
| Cause | Agent chose to ask | opencode paused awaiting approval |
| Almadel learns via | `almadel_ask` tool call | Plugin's permission hook fires |
| Agent cooperated? | Yes | No — it doesn't know |
| Answer is | Free text | allow / deny + scope |
| Delivered by | Resolving the pending tool call | Resolving the hook in-process |
| UI | Compose box | Buttons + the command shown |

Both now block *inside the process*, which is what §2.1 bought. Neither requires guessing state from outside.

### 12.2 Why the plugin makes this work

The old design sent a message from outside and watched an event stream to guess what happened. If a permission fired mid-turn, that send never returned — the session waits on the permission, tool results never settle, the caller hangs. This is a real reported failure mode in opencode headless subagents, not a hypothetical.

In-process, there's nothing to infer. The hook fires, the plugin calls Almadel, awaits your decision, and returns an effect:

```ts
const onPermission = (agent) => async (event) => {
  if (event.action === "read") return;            // never escalate reads
  const rule = matchAutoPolicy(event);
  if (rule) { event.effect = rule; return; }

  const decision = await postAndWait(agent, {     // blocks this turn only
    ticket: agent.ticket, tool: event.action,
    command: event.resources?.join(" "),
  });
  event.effect = decision;                        // "allow" | "deny"
};
```

**Verify this hook on your opencode version before building on it.** Its history is rocky: `permission.ask` was defined in the SDK but never triggered for a long time, because the active permission module published bus events instead of calling the plugin hook; even after wiring, it was guarded so it only fired for commands that already had an allow rule — skipping exactly the first-encounter case you need. The v2 `permission.hook("evaluate")` surface is the current one and runs for allow and ask decisions, letting the hook change the effect. The fallback pattern people shipped is the generic `event` hook plus a reply call against the permission endpoint. **Pin your opencode version.**

### 12.3 Who does what

- **Server owns the decision.** You click; it writes to the thread and queues a job. It never talks to opencode — it can't, and shouldn't.
- **Plugin owns the delivery.** It's inside the process, so it's the only thing that can resolve anything.

```
you click "allow"
  → POST /api/tickets/TCK-412/permission       (browser → server)
  → decision recorded, job queued              (server)
  → { type: "permission", ... }                (server → plugin, next poll)
  → event.effect = "allow"                     (in-process, hook resolves)
  → turn resumes, events flow again
```

Latency is one poll cycle, up to 35 s. Against a twenty-minute run that's fine. If it isn't, shorten the poll rather than adding a push channel.

### 12.4 Most permissions must never reach you

Forty prompts per ticket and you stop using this. Configure opencode's own permission rules per slot so routine work generates no request at all:

- **Pre-approved:** test runners, linters, `git add`/`commit`, package installs, reads and writes inside the repo.
- **Escalates:** `git push`, migrations, writes outside the repo, network calls outside the allowlist, anything touching credentials.

Escalation being exceptional is what makes the amber badge mean something.

### 12.5 Reconciliation

Mostly unnecessary now. With tools as the only path, `blocked` means a turn is genuinely paused inside a tool call or a hook — a fact, not an inference from an event stream. There is no "the agent was told to stop and didn't" case left to detect.

What remains is the deferred branch of §12.6: once `almadel_ask` times out and the agent ends its turn, the ticket is blocked with no pending call to resolve, so the answer goes in as an injected message instead. The server knows which by checking for a waiting long poll on the question id.

A permission pending with no answer for an hour is auto-denied so nothing pends silently forever.

### 12.6 The hybrid ask

`almadel_ask` blocks and resolves with your answer, so the agent continues mid-turn with everything intact. Much better than telling the model to end its turn and hoping.

But a pending tool call is fragile: it may hit an execution timeout, and it definitely doesn't survive an opencode restart. A block lasting until tomorrow morning can't live inside one.

```ts
almadel_ask: async ({ question }) => {
  const qid = await postQuestion(agent.ticket, question);
  const answer = await waitForAnswer(qid, { timeout: 5 * 60_000 });

  if (answer) return answer;                    // fast path

  await markDeferred(qid);                      // slow path
  return "No answer yet. Stop here and end your turn — " +
         "the answer will arrive as a new message.";
}
```

Two paths, one question row:

- **Fast** (answered within ~5 min): tool returns, turn continues. The common case when you're at your desk.
- **Slow**: the tool returns an instruction to stop, the turn ends, and the answer is later injected as a new message into the still-live session. Context survives because the session does.

The question, its `deferred` flag, and the answer are all rows on the ticket, so the UI is identical either way — you don't know or care which path you're on when you type the reply. The server does: it resolves the waiting long poll on `/api/questions/{qid}` if one is parked, and queues a `reply` job if not.

Tune the timeout below opencode's tool execution limit, and pin it (§12.2).

---

## 13. Slot management

```
slot  →  fixed directory (~/src/almadel-api)
      →  one opencode instance, one plugin
      →  PORT_BASE from the server at registration
```

`PORT_BASE` matters when two slots share a machine: both agents running `npm run dev` fight over 8000 otherwise. The column prompt tells the agent its band.

Between tickets, return to the default branch and leave the ticket branch in place for review. `node_modules` stays warm, which is the main practical gain over worktree-per-ticket.

Periodically prune merged `run/*` branches — this is now a branch-hygiene problem rather than a directory-hygiene one.

---

## 14. Failure handling

| Failure | Detection | Response |
|---|---|---|
| Agent vanishes | `last_poll` older than 90s | Requeue its tickets, mark offline |
| Agent forgets to move | Session idle, ticket in-flight | Server moves by outcome |
| Permission unanswered | Pending >1h (§12.5) | Auto-deny, set `blocked` |
| `almadel_ask` times out | 5 min, no answer | Mark deferred, agent ends turn, resume by injection (§12.6) |
| opencode too old for tools | Capability check at registration | **Refuse registration**, 409 with the required version (§9.2) |
| Installed but never joined | Nothing registers | Dormant by design (§2.11); `/join` stays pending |
| Interactive agent crashes | Poll stops | Lease expiry requeues its ticket; slot stays gone until someone rejoins (§2.11) |
| Unattended agent crashes | Poll stops | systemd restarts; env vars rejoin it automatically |
| Plugin didn't load | `/almadel` command missing | Visible in-app immediately; restart or check `opencode.json` |
| Server unreachable after join | Poll fails | Retry with backoff, keep the enlistment; `/almadel status` shows disconnected |
| Wrong-project job | Plugin verify (§3.1) | Error comment, no checkout |
| Registration mismatch | `git_remote` differs | **Refuse registration** |
| opencode crashes | Poll stops | systemd restarts; lease expiry requeues |
| Server restarts | Plugins reconnect on next poll | Nothing to do — poll is stateless |
| Dirty slot directory | Checkout fails | Fail ticket with the git error |

That last one deserves a rule: **never `git checkout -f` to recover.** A dirty slot means someone was working in it, and force-discarding their changes to run a ticket is the kind of thing that ends adoption. Fail loudly.

---

## 15. Build order

**Phase 1 — the boring path.** `almadel start`: board CRUD, projects, SQLite, embedded UI. Plugin with `/almadel join` / `status` / `leave`, that then polls, checks out, dispatches, and registers `almadel_move` / `almadel_comment`. One project, one agent, no streaming, no blocking. A ticket goes in, a branch comes out. This is the whole product; everything after is quality of life.

**Phase 2 — visibility.** Event push, stored `events` table, SSE fan-out, live log pane, cancel.

**Phase 3 — the ask loop.** `almadel_ask` with the hybrid timeout, blocked states, chat panel, permission hook and routing. The differentiator, and it depends on Phase 2.

**Phase 4 — multi-project, multi-agent.** Join tokens, roster grouping, lease expiry, port bands, WIP limits.

**Phase 5 — packaging.** `bun build --compile`, npm publish for both packages, systemd unit, Dockerfile.

Spike before Phase 1: **verify the permission hook fires on your opencode version** (§12.2). If it doesn't, the architecture's main advantage over the old design evaporates and it's worth knowing on day one.

---

## 16. Deliberately deferred

- **NATS.** Cut twice. Earns its place at multi-host scale with agent-to-agent messaging; at a handful of agents and one server, long-poll HTTP does the same job with no broker.
- **Agent-to-agent communication.** The version that would earn its keep is a shared blackboard — agents writing `claim: models.py → TCK-412` before editing — not agents talking in prose.
- **microVM isolation (forkd, gVisor, Firecracker).** The realistic threat isn't sandbox escape, it's an agent reading a prompt injection while holding a push token. Spend the effort on scoped short-lived credentials and an egress allowlist instead. Revisit only if speculative fan-out (branch a live agent three ways) becomes a product feature — nothing else in this stack can do that.
- **Cross-project tickets.** A ticket touching two repos. Genuinely useful, genuinely complicated; §3 deliberately makes it impossible for now.
- **Swapping opencode.** §12 is not portable — it depends on opencode's session model, injectable replies, and permission hooks. A different runtime means redesigning the ask loop, not re-pointing a client.

---

## 17. Open questions

1. **Does a blocked agent hold its slot?** Indefinitely, currently. Either accept it or let an agent hold a blocked session while claiming new work — better utilisation, much more state.
2. **Where do PRs happen?** Agent runs `gh pr create`, or Almadel does it on move-to-review. The second keeps tokens out of the agent's environment.
3. **Multiple slots per machine.** Two checkouts and two opencode instances, or one instance with sessions? The latter breaks §2.2's fixed-directory assumption.
4. **Secrets.** Scoped short-lived tokens per project, not a PAT with org access.
5. **Prompt versioning.** Editing a column's prompt silently changes behaviour for every future ticket. Store the rendered prompt on the ticket at dispatch.
6. **Who reviews?** The unsolved bottleneck in this whole category — parallel agents mean parallel diffs, and your attention doesn't parallelise.

---

## 18. Prior art

This category filled in fast. Check these before building; several already support opencode.

| Project | What it already does |
|---|---|
| **Docker Agent Board** | Column-as-prompt, exactly. Moving a card sends that column's prompt to its agent. TUI, tmux, worktree per card. |
| **Cline Kanban** | Closest to the full product. Browser board, worktree per card, mixed agent fleets, inline diff comments fed back to the agent. |
| **Vibe Kanban** | The reference implementation, supports opencode. Now sunsetting into community maintenance. |
| **ai-agent-board** | Drag-and-drop, opencode support, real-time streaming, parallelism slider. |
| **Agent Orchestrator** | Live kanban across workers, PRs, CI runs, reviews. |
| **Fusion** | Kanban + plan-review-execute gates + per-task worktrees, multi-node. |
| `awesome-agent-orchestrators` | The full list — dozens more. |

**What isn't taken.** Almost all of these are local tools launched from inside a repo. Nothing does remote enlistment — a hosted board that machines dial into by URL — and nothing does the ask loop, where an agent stops mid-run, holds its session, and gets unblocked by a human in chat. Those two are the honest remaining ground. The board is not.

Worth stealing rather than rebuilding: everything about diff review, which is the part this design is weakest on.
