import type { AlmadelClient } from "./http.ts";
import type { AlmadelState } from "./state.ts";
import { CommentKind } from "./types.ts";
import { returnToRepoRoot } from "./git.ts";
import type { GitRunner } from "./git.ts";
import { askQuestion } from "./ask.ts";
import { z } from "zod";

export interface ColumnRef {
  id: string;
  name: string;
}

export interface JoinArgs {
  server: string;
  project: string;
  token?: string;
  label?: string;
}

export interface ToolDeps {
  client: AlmadelClient;
  state: AlmadelState;
  git: GitRunner;
  repoRoot: string;
  getBoard: () => Promise<ColumnRef[]>;
  enlist: (args: JoinArgs) => Promise<string>;
  leave: () => Promise<string>;
  status: () => Promise<string>;
}

export function requireTicket(state: AlmadelState): string {
  if (!state.currentTicket) {
    throw new Error(
      "no ticket is currently held by this agent — almadel tools require an active ticket",
    );
  }
  return state.currentTicket;
}

/** Column list as a zod enum, so off-board moves are structurally impossible. */
export function columnEnum(columns: ColumnRef[]) {
  const ids = columns.map((c) => c.id);
  return z.enum(ids.length > 0 ? (ids as [string, ...string[]]) : ["__none__"]);
}

function describeColumns(columns: ColumnRef[]) {
  if (columns.length === 0) return "(no columns loaded)";
  return columns.map((c) => `${c.name} (${c.id})`).join(", ");
}

export async function makeAlmadelTools(deps: ToolDeps) {
  const { client, state } = deps;
  const columns = await deps.getBoard();
  const colEnum = columnEnum(columns);
  const colDesc = describeColumns(columns);

  return {
    almadel_join: {
      description:
        "Join this agent to an Almadel server. Pass the server URL and project name (or id). Registers the agent, stores the token in memory, and starts polling for work. Use once per process.",
      args: {
        server: z.string().min(1),
        project: z.string().min(1),
        token: z.string().optional(),
        label: z.string().optional(),
      },
      async execute(args: JoinArgs): Promise<string> {
        if (state.running) {
          return `already joined (agent ${state.agentId} on ${state.serverUrl}) — leave first to rejoin`;
        }
        return deps.enlist(args);
      },
    },

    almadel_status: {
      description: "Show this agent's Almadel status: server, project, agent id, and current ticket.",
      args: {},
      async execute(): Promise<string> {
        return deps.status();
      },
    },

    almadel_leave: {
      description:
        "Deregister this agent from the Almadel server and stop polling. The held ticket (if any) is requeued by the server.",
      args: {},
      async execute(): Promise<string> {
        return deps.leave();
      },
    },

    almadel_read: {
      description:
        "Read the current Almadel ticket and its comment thread. Returns the ticket, its column, and the full comment history.",
      args: {},
      async execute(): Promise<string> {
        const ticket = requireTicket(state);
        const thread = await client.getTicket(ticket);
        return JSON.stringify(thread, null, 2);
      },
    },

    almadel_comment: {
      description:
        "Post a comment on the current Almadel ticket. Use kind='plan' for a plan, 'comment' for a note.",
      args: {
        kind: CommentKind,
        body: z.string(),
      },
      async execute(args: { kind: z.infer<typeof CommentKind>; body: string }): Promise<string> {
        const ticket = requireTicket(state);
        await client.comment(ticket, { kind: args.kind, body: args.body });
        return "comment posted";
      },
    },

    almadel_move: {
      description: `Move the current ticket to another column, ending this stage. Valid columns: ${colDesc}.`,
      args: {
        column: colEnum,
        note: z.string().max(2000).optional(),
      },
      async execute(args: { column: string; note?: string }): Promise<string> {
        const ticket = requireTicket(state);
        await client.move(ticket, { column: args.column, note: args.note });
        // Stage complete: keep the worktree + branch for review, re-anchor cwd
        // back to the primary checkout for the next session.
        await returnToRepoRoot(deps.git, deps.repoRoot);
        state.currentWorktree = null;
        state.currentTicket = null;
        state.status = "idle";
        return "ticket moved; stage complete";
      },
    },

    almadel_ask: {
      description:
        "Ask a human a question and wait (up to 5 minutes) for an answer. Blocks the agent until answered or timed out.",
      args: {
        question: z.string().min(1).max(4000),
      },
      async execute(args: { question: string }): Promise<string> {
        const ticket = requireTicket(state);
        return askQuestion(client, state, ticket, args.question);
      },
    },

    almadel_message: {
      description:
        "Send a direct message back to the human who messaged this agent. Use this to reply to a direct message.",
      args: {
        body: z.string().min(1),
      },
      async execute(args: { body: string }): Promise<string> {
        if (!state.agentId) return "not joined to an Almadel server";
        await client.sendMessage(state.agentId, { body: args.body });
        return "message sent";
      },
    },
  };
}
