# 05 — The Column / Pipeline Editor

Editing a column is editing the workflow — that is the whole point of §4. The
editor is where prompts, WIP limits, and the `next`/`fail` wiring are changed,
and it must be low-friction because it *is* the pipeline definition.

## Access

- From a column header: "edit" opens that column's form.
- A board-level "edit pipeline" opens a list of all columns with reorder
  controls and add/remove.

Backed by `GET`/`PUT /api/projects/{id}/columns` (§8). Read and edit are the
same endpoint family; the board re-renders on save.

## Column form fields (§4.1)

| Field | Control | Notes |
|---|---|---|
| `name` | text | shown on the column header |
| `prompt` | textarea (multi-line), empty = human gate | the stage prompt; template variables are documented inline |
| `next` | select of sibling columns | where `almadel_move` sends it by default |
| `fail` | select of sibling columns (optional) | where failures land |
| `wip_limit` | number, blank = unlimited | caps concurrent tickets in this column |
| `position` | reorder via drag or up/down | determines left-to-right order |

`prompt` being empty is the **entire** human-gate mechanism (§4.1) — there is no
separate "manual" toggle. The editor must make that explicit: the prompt field
is labelled with "leave empty for a manual gate (nothing auto-dispatches)".

## Prompt template variables (§4.2)

The prompt textarea documents and previews the available variables:

| Variable | Contents |
|---|---|
| `{{ticket.id}}` | `TCK-412` |
| `{{ticket.title}}`, `{{ticket.body}}` | as written |
| `{{thread}}` | full comment history, incl. prior stages' artifacts |
| `{{branch}}` | `run/TCK-412` |
| `{{project}}` | `almadel-api` |
| `{{port_base}}` | the slot's port band |

A **preview** control renders the prompt against a sample ticket so the author
sees what an agent will actually receive. (This is also where §17.5's
"store the rendered prompt on the ticket at dispatch" becomes visible later —
the editor previews; dispatch stores.)

## Enumeration flows into the tools (§10)

`almadel_move`'s `column` argument is a `z.enum` built from this project's
columns. Editing a column name changes what the agent sees on its **next
registration** (§10) — not mid-run. The editor surfaces this: "changes apply to
newly joined agents; running agents keep the columns they registered with."
Renaming a column is therefore a two-step affordance (edit + the note), never a
silent surprise.

## Ordering and WIP sanity

- `position` reorder is a drag on the pipeline list.
- The editor warns (does not block) when the sum of `wip_limit`s exceeds the
  project's slot count (§4.3) — queueing is legal, just worth flagging.

## Validation

Client-side: `name` required; `next`/`fail` must reference existing columns (or
none); `wip_limit` a non-negative integer. Server re-validates the same schema
(shared zod) and returns 400 with issue details, rendered inline.
