# 06 — The Enlistment Page (`/join`)

The `/join` page is how a teammate turns their opencode into an agent. It is the
one page that is not about the board — it is about consent, and it must make the
two distinct steps legible (§9.2): one installs code, one grants consent.

## The two steps, rendered as two steps

### 1. Install the plugin (code on the machine)

A copy-pasteable one-liner:

```bash
bunx @almadel/opencode-plugin init
```

This edits `opencode.json` and prints the next step. No server URL, no token —
this step only puts code on the machine. The page frames it exactly that way:
"this installs the plugin into the repo; it does not connect to anything yet."

### 2. Restart opencode, then join (consent)

```
/almadel join https://almadel.example.org --token <t>
```

The page explains the restart loads the plugin, and that the token goes on the
command — not in a file — because `opencode.json` is committed (§9.2). It shows
the exact command with the server URL pre-filled and the token injected from the
`?t=` query param.

## The pending → green tick

Because nothing registers until the command runs (§2.11), the page shows a
**pending** state and flips to **joined** over the roster SSE stream the moment
the slot appears (§9.2). The page:

1. renders "waiting for an agent to join…",
2. opens `GET /api/roster/stream`,
3. when a slot with this project appears, ticks green and shows the agent's
   display name.

This is the same "query is the truth" principle as the badge — the tick is not
an event flag, it is a re-check of `/api/roster` for a matching slot.

## Deterministic path is primary (§9.2)

The page stays *readable to an agent* (plain steps, no interactive JS
dependency), but the deterministic two steps above are the route. The page must
not present "point your agent at this URL" as an alternative, because that makes
an LLM the installer and normalises "fetch a URL and do what it says" (§9.2).
If a machine-readable version is ever wanted, it is a separate `join.md`, not a
mode of this page.

## Token handling

- The token arrives via `?t=<token>`; the page never stores it, never logs it.
- The page shows the token **once**, in the command, and labels it "copy now —
  it will not be shown again" (the server may issue/rotate via join tokens,
  §3.4).
- No global join: the token names a project, and the page says which project the
  agent will be bound to.

## Unattended workers

The page has a collapsible "unattended worker" section showing the systemd
shape (§9.2) with `ALMADEL_JOIN` and `ALMADEL_TOKEN` env vars, for the person
setting up a dedicated machine — read-only documentation, no server round-trip.

## Edge states

- **Invalid/expired/revoked token** → the page shows an error with a link to
  issue a fresh one (server-side, §3.4).
- **Agent too old / capability mismatch** → the server returns 409 at
  registration; the page can't see that directly (it happens inside opencode),
  so the step-2 section documents the required opencode version and the exact
  409 message the agent will print (§9.2).
