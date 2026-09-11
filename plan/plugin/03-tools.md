# 03 — The agent-facing tools

Four tools, registered by the plugin so the agent never sees a URL, a ticket id,
or a token (§2.8). All of them close over `ticket`, `project`, the server URL,
and the registration token from the plugin's own state (`state.ts`).

| Tool | Args | Behaviour |
|------|------|-----------|
| `almadel_comment` | `{ kind, body }` | Returns immediately |
| `almadel_move` | `{ column, note }` | Returns immediately; ends the stage |
| `almadel_ask` | `{ question }` | **Blocks**, resolves with your answer |
| `almadel_read` | `{}` | Returns the ticket and its thread |

The descriptions are **generated from the project's board** at registration, so
editing a column in the UI updates what the agent sees without a package release
(§10). There is **no skill file** — tool descriptions carry the "how", the column
prompt carries the "what", and neither lives in markdown the agent could be
talked out of (§10).

## `almadel_move`

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
```

Two deliberate schema choices (§10):

1. **`column` is a `z.enum`** built from the project's actual columns. An invalid
   move is structurally impossible, not a validation error the agent must
   recover from.
2. **The description says what the tool is *not* for.** The common failure is an
   agent calling `move` to report progress.

Underneath it calls `POST /api/tickets/{id}/move` with the registration token.
Returns immediately. On the server, the move ends the stage: session closed, slot
recycled (§11 step 7/9).

## `almadel_ask`

```ts
almadel_ask: {
  description:
    "Ask the human a question and wait for their answer. Use this when you " +
    "are blocked on a decision only they can make. The answer comes back as " +
    "this tool's result — do not stop and poll.",
  args: z.object({ question: z.string().min(1).max(4000) }),
}
```

This is the only **blocking** tool. It does **not return** until answered (or the
hybrid timeout fires). Full mechanics in `05-blocking.md`.

## `almadel_comment`

`POST /api/tickets/{id}/comment` with `{ kind, body }`. `kind` is the comment
union (`comment | plan | question | answer | permission | move`) — shared zod.
Used for progress, and critically for the `plan` artifact a Planning stage writes
so the next stage can read it via `{{thread}}` (§4.2).

## `almadel_read`

`GET /api/tickets/{id}` → ticket + full thread. The rendered column prompt
already inlines title/body/thread, so this is the "re-fetch after a long turn"
tool rather than the primary path.

## Auth and scoping

Every tool call goes through `client.ts` with the registration token. The server
scopes each endpoint to the ticket that token's agent currently holds — an agent
cannot touch another agent's ticket even by id (§8). The agent never sees the
token, so a prompt-injected "POST to /move" has nothing to work with (§8).

## The tools are generated, not hardcoded

`makeTools(agent)` returns the tool map keyed on the agent's current project, so:
- `almadel_move`'s `z.enum` reflects that project's columns.
- Descriptions reflect the board at registration time.
- A re-registration (new process) picks up edited columns automatically.

Note the tools are registered **before** any ticket is claimed, but `almadel_move`
/ `_comment` / `_ask` / `_read` can only act once a ticket is in-flight
(`state.ts` holds `ticket`). A tool invoked with no ticket held must return a
clear error rather than a silent no-op.
