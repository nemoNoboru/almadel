import type { AlmadelClient } from "./http.ts";
import type { EventItem } from "./types.ts";

/**
 * Event push pipeline: filters, batches, and pushes session events to the
 * server. The event hook must NEVER block the session — it enqueues and
 * returns; a timer flushes batches to the server.
 */

const BATCH_FLUSH_MS = 250;
const BATCH_BYTES = 4 * 1024;
const BUFFER_LIMIT = 10_000;

/** Events that are streamed to the server. Everything else is dropped. */
const FILTERED_KINDS = new Set([
  "message.updated",
  "message.part.updated",
  "tool.execute.before",
  "tool.execute.after",
  "permission.asked",
  "permission.replied",
  "session.idle",
  "session.error",
]);

/** Kinds that must flush immediately (never wait for the batch window). */
const IMMEDIATE_KINDS = new Set([
  "permission.asked",
  "permission.replied",
  "session.idle",
  "session.error",
]);

export function shouldStream(kind: string): boolean {
  return FILTERED_KINDS.has(kind);
}

export function isImmediate(kind: string): boolean {
  return IMMEDIATE_KINDS.has(kind);
}

export class EventPipeline {
  private client: AlmadelClient;
  private ticket: string;
  private buffer: EventItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;
  private seq = 0;
  private log: (msg: string) => void;

  constructor(
    client: AlmadelClient,
    ticket: string,
    log: (msg: string) => void = () => {},
  ) {
    this.client = client;
    this.ticket = ticket;
    this.log = log;
  }

  /** Enqueue an event. Never throws. */
  enqueue(kind: string, payload: unknown): void {
    if (!shouldStream(kind)) return;
    this.buffer.push({ kind, payload });
    if (this.buffer.length >= BUFFER_LIMIT) this.buffer.shift();

    if (isImmediate(kind)) {
      void this.flush();
      return;
    }

    const size = this.buffer.reduce(
      (acc, e) => acc + e.kind.length + JSON.stringify(e.payload).length,
      0,
    );
    if (size >= BATCH_BYTES) {
      void this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, BATCH_FLUSH_MS);
    }
  }

  /** Flush the buffer to the server. Never throws (buffers on failure). */
  async flush(): Promise<void> {
    if (this.pushing || this.buffer.length === 0) return;
    this.pushing = true;
    const events = this.buffer;
    this.buffer = [];
    try {
      await this.client.pushEvents(this.ticket, { events });
    } catch (err) {
      this.log(`event push failed, buffering: ${String(err)}`);
      this.buffer = [...events, ...this.buffer].slice(0, BUFFER_LIMIT);
    } finally {
      this.pushing = false;
    }
  }

  /** Attach a server-assigned sequence to an outbound event (best effort). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
