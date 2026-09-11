# 05 — Blocking and unblocking

Two things stop an agent, and only one involves the agent cooperating (§12.1):

| | Question | Permission |
|---|---|---|
| Cause | Agent chose to ask | opencode paused awaiting approval |
| Almadel learns via | `almadel_ask` tool call | plugin's permission hook fires |
| Agent cooperated? | Yes | No — it doesn't know |
| Answer is | Free text | allow / deny + scope |
| Delivered by | Resolving the pending tool call | Resolving the hook in-process |
| UI | Compose box | Buttons + the command shown |

Both block **inside the process**, which is what the plugin architecture bought:
there is no state to infer from outside (§12.2).

## The permission hook (permission.ts)

**The spike is done — see `09-spike-results.md`.** On opencode 1.18.30 the
`permission.ask` hook and `permission.hook("evaluate")` surface are both dead.
The working mechanism is the fallback pattern §12.2 named, proven end-to-end:

1. The plugin's generic `event` hook receives `permission.asked`
   (`properties` = the `PermissionRequest` shape) and `permission.replied`
   (`{sessionID, requestID, reply}`).
2. The plugin resolves it by calling
   `client.postSessionIdPermissionsPermissionId({ path: { id: sessionID,
   permissionID }, body: { response: "once" | "always" | "reject" } })`.

```ts
const onEvent = (agent) => async ({ event }) => {
  if (event.type !== "permission.asked") return;
  const p = event.properties;
  if (p.permission === "read") return;            // never escalate reads
  const rule = matchAutoPolicy(p);                // §12.4 pre-approve routine work
  if (rule) { await reply(agent, p, rule); return; }

  await postPermissionRequest(agent, {            // POST /api/tickets/{id}/permission-request
    ticket: agent.ticket, tool: p.permission,
    command: p.metadata?.command ?? p.patterns.join(" "),
    permissionID: p.id, sessionID: p.sessionID,
  });
  // No reply here — the decision arrives as a { type: "permission" } job on the
  // next poll, and the plugin then calls the reply endpoint above.
};
```

Rules:

1. **Reads never escalate** — `p.permission === "read"` (or the read tool set)
   returns immediately.
2. **Auto-policy first** — match the slot's opencode permission rules so routine
   work (test runners, linters, `git add`/`commit`, package installs, in-repo
   reads/writes) never reaches a human (§12.4). This is configured in opencode's
   own `permission` config, so most requests never surface as `permission.asked`.
3. **Otherwise forward to Almadel** — POST the permission to the Almadel server,
   which notifies the human. The plugin does **not** reply yet; it waits for the
   `{ type: "permission" }` job, then calls the reply endpoint.

Latency is one poll cycle, up to 35s — fine against a twenty-minute run; if not,
shorten the poll rather than add a push channel (§12.3).

**Pre-approved vs escalates** (§12.4): pre-approved covers the boring set;
escalates covers `git push`, migrations, writes outside the repo, network calls
outside the allowlist, anything touching credentials. Escalation being
exceptional is what makes the amber badge meaningful.

**Launch-mode constraint (from the spike).** Holding a permission open for a
human only works if opencode is launched in a mode without the `opencode run`
CLI's auto-reject loop. The unattended worker must use `opencode serve` + the
plugin driving sessions via `client.session.promptAsync`, not `opencode run`.
See `09-spike-results.md`.

## The hybrid ask (ask.ts)

`almadel_ask` blocks and resolves with your answer, so the agent continues
mid-turn with everything intact. But a pending tool call may hit an execution
timeout and definitely doesn't survive an opencode restart, so a block lasting
until tomorrow can't live inside one (§12.6):

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

- **Fast** (answered within ~5 min): tool returns, turn continues. The common
  case when the human is at their desk.
- **Slow**: the tool returns an instruction to stop, the turn ends, and the
  answer is later injected as a new message into the still-live session. Context
  survives because the session does.

The question, its `deferred` flag, and the answer are all rows on the ticket
(`questions` table), so the UI is identical either way. The server decides which
path: it resolves the waiting long poll on `/api/questions/{qid}` if one is
parked, and queues a `{ type: "reply" }` job if not (§12.6).

Tune the 5-minute timeout below opencode's tool execution limit, and pin it
(§12.6).

## Delivery on the plugin side

When a `{ type: "reply" }` job arrives (`jobs.ts` → `ask.ts`):

- If a pending `almadel_ask` is still parked on that ticket → resolve the tool
  call with the text (fast path delivery).
- If the ask already timed out (deferred) → inject the answer as a new message
  into the still-live session (slow path delivery).

When a `{ type: "permission" }` job arrives → resolve the pending hook with
`event.effect = decision` (in-process, the turn resumes, events flow again, §12.3).

## Who owns what (§12.3)

- **Server owns the decision** — you click; it writes the thread and queues a job.
  It never talks to opencode.
- **Plugin owns the delivery** — it's inside the process, so it's the only thing
  that can resolve a tool call or a hook.

## Reconciliation (§12.5)

Mostly unnecessary now: with tools as the only path, `blocked` means a turn is
genuinely paused inside a tool call or hook — a fact, not an inference. What
remains is the deferred ask branch (a blocked ticket with no pending call to
resolve) and the 1-hour auto-deny for unanswered permissions — both are server
concerns. The plugin's only reconciliation duty is reporting what it actually
observes via telemetry on each claim.
