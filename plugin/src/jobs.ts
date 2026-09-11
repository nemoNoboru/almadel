import type { AlmadelClient } from "./http.ts";
import type { AlmadelConfig } from "./config.ts";
import type { AlmadelState } from "./state.ts";
import type { Job } from "./types.ts";
import { prepareTicketWorktree, returnToRepoRoot, GitError } from "./git.ts";
import type { GitRunner } from "./git.ts";

export interface JobContext {
  client: AlmadelClient;
  config: AlmadelConfig;
  state: AlmadelState;
  git: GitRunner;
  log: (msg: string) => void;
  /** Called with a task prompt to dispatch into a session. */
  dispatchPrompt: (prompt: string, ticket: string, branch: string, model: string | null) => Promise<void>;
  /** Called when a cancel job arrives. */
  onCancel: (ticket: string) => Promise<void>;
  /** Called with a reply text to inject (resolve pending ask or new message). */
  onReply: (ticket: string, text: string) => Promise<void>;
  /** Called with a direct-message body from a human. */
  onMessage: (text: string) => Promise<void>;
}

const POLL_INTERVAL_MS = 35_000;

/**
 * Long-poll claim loop. Runs for the lifetime of the process: every iteration
 * POSTs /api/claim with telemetry, then dispatches whatever job comes back.
 */
export async function pollLoop(ctx: JobContext): Promise<void> {
  if (!ctx.state.running) return;
  while (ctx.state.running) {
    try {
      const job = await ctx.client.claim({
        project: ctx.config.project,
        agent: ctx.state.agentId ?? "",
        slot: {
          status: ctx.state.status,
          ticket: ctx.state.currentTicket ?? undefined,
          since: Date.now(),
        },
      });
      if (job) {
        await dispatch(ctx, job);
        continue;
      }
    } catch (err) {
      ctx.log(`claim failed: ${String(err)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function dispatch(ctx: JobContext, job: Job): Promise<void> {
  // Direct messages carry no ticket; handle them before the ticket-scoped paths.
  if (job.type === "message") {
    ctx.log("job: message");
    if (job.project !== ctx.config.project) {
      ctx.log(`project mismatch: job=${job.project} ours=${ctx.config.project} — refusing`);
      return;
    }
    await ctx.onMessage(job.text);
    return;
  }

  ctx.log(`job: ${job.type} ticket=${job.ticket}`);

  // Projects are a namespace: verify on every job before touching anything.
  if (job.project !== ctx.config.project) {
    ctx.log(
      `project mismatch: job=${job.project} ours=${ctx.config.project} — refusing`,
    );
    // Report the mismatch as an error comment; do NOT checkout or prompt.
    try {
      await ctx.client.comment(job.ticket, {
        kind: "comment",
        body: `project mismatch: job for '${job.project}' delivered to agent enlisted for '${ctx.config.project}'. Ignoring.`,
      });
    } catch (err) {
      ctx.log(`mismatch comment failed: ${String(err)}`);
    }
    return;
  }

  switch (job.type) {
    case "task":
      await handleTask(ctx, job);
      break;
    case "reply":
      await ctx.onReply(job.ticket, job.text);
      break;
    case "permission":
      await handlePermission(ctx, job);
      break;
    case "cancel":
      await ctx.onCancel(job.ticket);
      break;
  }
}

async function handleTask(
  ctx: JobContext,
  job: Extract<Job, { type: "task" }>,
): Promise<void> {
  ctx.state.currentTicket = job.ticket;
  ctx.state.status = "working";
  let worktree: string;
  try {
    worktree = await prepareTicketWorktree(ctx.git, {
      repoRoot: ctx.config.repoRoot,
      branch: job.branch,
      defaultBranch: ctx.config.defaultBranch,
      ticket: job.ticket,
    });
  } catch (err) {
    if (err instanceof GitError) {
      ctx.log(`worktree setup failed: ${err.message}`);
      await failTicket(ctx, job.ticket, err.message);
      return;
    }
    throw err;
  }

  // Each ticket runs in its own worktree on its own branch. Re-anchor the
  // process cwd so the agent's shell commands operate on the isolated checkout.
  ctx.state.currentWorktree = worktree;
  try {
    process.chdir(worktree);
  } catch (err) {
    ctx.log(`chdir to worktree failed: ${String(err)}`);
  }

  // Server has already rendered the prompt (template vars substituted). Send it
  // verbatim — the plugin must NOT re-render.
  await ctx.dispatchPrompt(job.prompt, job.ticket, job.branch, job.model);
}

async function handlePermission(
  ctx: JobContext,
  job: Extract<Job, { type: "permission" }>,
): Promise<void> {
  // The permission job is a fallback for when no HTTP waiter was parked. The
  // active waiter is resolved directly by the blocked /permission-request call.
  ctx.log(
    `permission job ${job.permission_id} -> ${job.decision}/${job.scope} (no parked waiter)`,
  );
}

async function failTicket(
  ctx: JobContext,
  ticket: string,
  reason: string,
): Promise<void> {
  ctx.state.status = "failed";
  try {
    await ctx.client.comment(ticket, {
      kind: "comment",
      body: `agent failed to start work: ${reason}`,
    });
  } catch (err) {
    ctx.log(`fail comment failed: ${String(err)}`);
  }
  // Return the process to the primary checkout and clear the worktree anchor.
  try {
    await returnToRepoRoot(ctx.git, ctx.config.repoRoot);
  } catch (err) {
    ctx.log(`re-anchor to repo root failed: ${String(err)}`);
  }
  ctx.state.currentWorktree = null;
  ctx.state.currentTicket = null;
  ctx.state.status = "idle";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
