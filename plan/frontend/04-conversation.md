# 04 — The Conversation Panel

The right pane is the conversation: one ticket's thread, the compose box, and
the controls appropriate to the ticket's state. It is opened by clicking a card
or an agent, and is **one thread, two views** (§5.6): the conversation *is* the
ticket's `comments` rows — the same data the card renders and `{{thread}}`
inlines into the next stage's prompt.

## Thread view

The thread renders `comments` in `created_at` order, styled by `author` and
`kind`:

| `kind` | Rendering |
|---|---|
| `comment` | plain note (human or agent) |
| `plan` | artifact block — visually distinct, the stage's deliverable |
| `question` | agent's question, highlighted |
| `answer` | human's reply to a question |
| `permission` | the command that was requested + the decision |
| `move` | a system line: "moved to Review by Gediel" |

`author` is `human`, `agent`, or `system`; each gets a distinct alignment and
colour so the human's own messages are instantly recognizable.

The thread also renders the **live log** for a `working` ticket (Phase 2) — see
`07-events-and-live-log.md`. Events that are transient (assistant text, tool
calls/results) live in the log, not in `comments`; the thread is the durable
artifact, the log is the running tail.

## Compose and controls by state (§5.5)

The bottom of the pane is a single region that swaps in the correct control for
the ticket's state. Never two at once, and never the wrong one for a state.

### `blocked_question` — prose

A compose box. Your reply is injected into the held session — full context
survives (§2.7). This is the fast path of the ask loop; the reply is a
`POST /api/tickets/{id}/reply` and the server routes it to the parked long poll
or a `reply` job depending on whether the ask already deferred (§12.6). The UI
does not care which path — it posts prose and shows it as an `answer` comment.

### `blocked_permission` — a decision

**Buttons, not a text box.** The pane shows the command that triggered the hook,
then `Allow` / `Deny`, each with a scope selector: `once` / `always` / `session`
(§5.5, §12). Submitting is `POST /api/tickets/{id}/permission` with
`{ decision, scope }`. Sending free text to a permission-paused session does
nothing useful (§5.2) — the UI must not offer it.

### `working` — a nudge

The compose box accepts but stores as a **pending message** (delivered when the
turn ends), shown as queued so the delay is not a surprise (§5.5). The pending
state is rendered from `pending_messages.sent_at IS NULL`.

### `idle` / `offline` / `done` / `failed` — read-only

No compose box. The thread is fully readable. `failed` shows the error comment
prominently at the top.

## Fixed actions

Two actions always available on a live (non-terminal) ticket, independent of
state:

- **Cancel** — `POST /api/tickets/{id}/cancel`. Confirmed first (it interrupts
  an agent and requeues/ends the run).
- **Take over** — `POST /api/tickets/{id}/takeover`. Marks the ticket
  human-owned and leaves the branch checked out so you can open it yourself
  (§5.5). The UI shows the branch name so you know what to `git checkout`.

## The not-a-side-channel warning (§5.6)

The pane carries a one-line, low-key note that everything written here is
permanently on the ticket and will be read by the agent that runs the next
stage. It is a permanent part of the compose area, not a popup, so it is seen
once and internalized. The design must not make the chat look like a private
DM.

## Selection and lifecycle

- Clicking a different card/agent repins the pane to the new ticket.
- Closing the pane (an explicit close button) empties it and stops the ticket
  SSE stream.
- If the pinned ticket's agent goes offline mid-conversation, the pane keeps the
  thread but swaps the compose box for a read-only notice ("agent offline").
