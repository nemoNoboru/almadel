import type { AlmadelClient } from "./http.ts";
import type { AlmadelState } from "./state.ts";

export const NO_ANSWER_MESSAGE =
  "No answer yet. Stop here and end your turn — the answer will arrive as a new message.";

const LONG_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;

/**
 * Hybrid fast/slow ask:
 *  - POST /api/tickets/{id}/ask -> {id}
 *  - long-poll GET /api/questions/{qid} for up to 5min
 *  - fast path: an answer arrives -> return it (tool resolves)
 *  - slow path: timeout -> return the NO_ANSWER_MESSAGE, agent ends its turn;
 *    the answer later arrives as a reply job and is injected as a new message.
 */
export async function askQuestion(
  client: AlmadelClient,
  state: AlmadelState,
  ticket: string,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const { id } = await client.ask(ticket, { question });

  const deadline = Date.now() + LONG_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return NO_ANSWER_MESSAGE;
    const result = await client.pollQuestion(id);
    if (result && typeof result.answer === "string") {
      return result.answer;
    }
    if (result === null) {
      // 204 -> server marked the question deferred. Stop waiting.
      return NO_ANSWER_MESSAGE;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
  }

  return NO_ANSWER_MESSAGE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
