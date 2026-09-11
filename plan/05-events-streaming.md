# 05 — Events & Streaming

Phase 2. Everything the agent does becomes a stream of events; the board's live-log
pane and any replay view read them back through SSE.

## Storage: `events` table

```sql
CREATE TABLE events (
  ticket_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT,
  created_at INTEGER,
  PRIMARY KEY (ticket_id, seq)
);
```

Per-ticket monotonic `seq`. `payload` is JSON (the event body). `kind` is one of the
filtered set (below). Sequence is what makes browser replay possible: reconnect with
`?after=<seq>` and resume exactly.

## Push contract (what the plugin sends)

The plugin pushes; the server never pulls (§8). Rules the server must **enforce
and rely on**:

- **Filter:** only assistant text, tool calls and results, permission requests,
  session idle, errors. Nothing else.
- **Batch** every ~250ms or ~4KB — but **permission, error, and idle flush
  immediately** (those need to be fast).
- **Buffer on failure and keep going.** The run matters; log display doesn't.
- **Sequence per ticket** — the plugin sends its own client-side seq, but the server
  assigns the authoritative seq on insert (trusting client seq is fragile across
  reconnect).

Server side: `POST /api/tickets/{id}/events` validates the batch, appends rows in a
single transaction (assigning server seq), then fans out to any open SSE subscribers
for that ticket. Idempotency concern: a retried batch after a network blip could
double-append. Mitigation in `12-open-questions.md` (client sends a `last_seq` or
batch id; server dedupes).

## Fan-out

`server/notify.ts` is reused: a `Map<ticketId, Set<SSEStream>>` of open response
writers. On append, each subscriber writes `event: tick` + the new rows. Slow or
dead subscribers are evicted (write error / timeout) — the stream is a view, not a
queue; the DB is the queue.

## SSE endpoints

### `/api/roster/stream`

`event: roster`, body = the current roster snapshot (or a change hint). Clients
treat every event as "something changed, re-render from `/api/roster`". This is
deliberate: the badge count is **never** an event-derived counter (§5.4).

### `/api/tickets/{id}/stream?after=<seq>`

On connect: replay all `events` with `seq > after` in order, then live-append.
`after` defaults to `0` (full history). A dropped connection resumes at its
last-seen `seq` — no cursor table needed, because `events` *is* the cursor.

## Badge from a query, not an event count

```sql
SELECT count(*) FROM tickets WHERE state LIKE 'blocked%';
```

§5.4: if the badge were incremented by SSE events, a refresh or dropped connection
loses it. The stream only says *re-render*. Open the UI cold after a weekend and the
count is right because it was never in the browser.

## Live log pane

The board's live-log pane is a thin client of `/api/tickets/{id}/stream`: it
renders `kind`/`payload` in chronological order. No separate log storage — the
`events` rows *are* the log. Filtering/formatting is client-side.

## Ordering and consistency

- Events for a ticket are strictly ordered by `seq`.
- `comments` (durable artifacts) and `events` (transient transcript) are separate
  tables but both append in time order; the UI shows comments for "the conversation"
  and events for "the live run" (§5.6 draws the roster thread from `comments`).
- A ticket's `{{thread}}` prompt variable is built from `comments`, not `events`.
