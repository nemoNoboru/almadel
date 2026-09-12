import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { loadConfig, hasEnvEnlistment, resolveProjectId } from "./config.ts";
import { AlmadelClient } from "./http.ts";
import { createState } from "./state.ts";
import { registerAgent } from "./register.ts";
import { pollLoop } from "./jobs.ts";
import { realGit, returnToRepoRoot } from "./git.ts";
import { makeAlmadelTools, type JoinArgs } from "./tools.ts";
import { decidePermission } from "./permission.ts";
import { EventPipeline } from "./events.ts";
import { PermissionRequestSchema } from "./types.ts";

/**
 * Structural subset of the opencode client we actually depend on. Declared
 * locally so the plugin can be tested with a fake and to insulate against SDK
 * type drift (1.14.24 .d.ts vs 1.18.30 runtime).
 */
export interface OpencodeClient {
  session: {
    create(input: { body: { title?: string } }): Promise<{ data?: { id: string } }>;
    promptAsync(input: {
      path: { id: string };
      body: { parts: { type: "text"; text: string }[] };
    }): Promise<unknown>;
    abort(input: { path: { id: string } }): Promise<unknown>;
  };
  postSessionIdPermissionsPermissionId(input: {
    path: { id: string; permissionID: string };
    body: { response: "once" | "always" | "reject" };
  }): Promise<{ data?: boolean }>;
}

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.error(`[almadel] ${msg}`);
}

export const AlmadelPlugin: Plugin = async (input: PluginInput) => {
  const client = input.client as unknown as OpencodeClient;
  const directory = input.directory;
  const cfg = loadConfig(directory);

  function logVerbose(msg: string) {
    if (cfg.verbose) log(msg);
  }

  const state = createState();
  const http = new AlmadelClient(cfg.serverUrl);
  let pipeline: EventPipeline | null = null;
  let pollStarted = false;

  async function enlist(args: JoinArgs): Promise<string> {
    if (!args.server) throw new Error("server URL is required");
    http.setServer(args.server);

    const projects = await http.listProjects();
    const projectId = await resolveProjectId(projects, args.project);

    const result = await registerAgent(http, {
      ...cfg,
      project: projectId,
      label: args.label ?? cfg.label,
    });

    state.serverUrl = args.server;
    state.projectId = projectId;
    state.agentId = result.agent_id;
    state.token = result.token;
    state.running = true;

    startPolling();
    return `joined ${args.server} as ${result.name} (${result.agent_id}) on project ${args.project}`;
  }

  async function leave(): Promise<string> {
    if (!state.running || !state.agentId) {
      return "not joined to any Almadel server";
    }
    try {
      await http.deregister(state.agentId);
    } catch (err) {
      log(`deregister failed: ${String(err)}`);
    }
    state.running = false;
    state.agentId = null;
    state.token = null;
    state.projectId = null;
    state.currentTicket = null;
    state.currentSession = null;
    state.status = "idle";
    state.board = null;
    return `left ${state.serverUrl ?? "server"}`;
  }

  async function status(): Promise<string> {
    return JSON.stringify(
      {
        joined: state.running,
        server: state.serverUrl,
        project: state.projectId,
        agent: state.agentId,
        status: state.status,
        ticket: state.currentTicket,
        session: state.currentSession,
      },
      null,
      2,
    );
  }

  async function dispatchPrompt(prompt: string, ticket: string, branch: string) {
    const created = await client.session.create({
      body: { title: `almadel ${ticket}` },
    });
    const sessionId = created.data?.id;
    if (!sessionId) {
      log("session create returned no id");
      return;
    }
    state.currentSession = sessionId;
    pipeline = new EventPipeline(http, ticket, log);
    await client.session.promptAsync({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: prompt }] },
    });
    logVerbose(`dispatched ${ticket} on branch ${branch} -> session ${sessionId}`);
  }

  async function onReply(ticket: string, text: string) {
    const sessionId = state.currentSession;
    if (!sessionId) {
      log(`reply for ${ticket} but no session — dropping`);
      return;
    }
    await client.session.promptAsync({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text }] },
    });
  }

  async function onMessage(text: string) {
    const created = await client.session.create({
      body: { title: "almadel message" },
    });
    const sessionId = created.data?.id;
    if (!sessionId) {
      log("message session create returned no id");
      return;
    }
    state.currentSession = sessionId;
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [
          {
            type: "text",
            text: `The human sent you a direct message:\n\n${text}\n\nRespond to the human using the almadel_message tool.`,
          },
        ],
      },
    });
    log(`handled direct message -> session ${sessionId}`);
  }

  async function onCancel(_ticket: string) {
    if (state.currentSession) {
      await client.session.abort({ path: { id: state.currentSession } });
    }
    // Re-anchor to the primary checkout; the ticket worktree is kept for review.
    try {
      await returnToRepoRoot(realGit, cfg.repoRoot);
    } catch (err) {
      log(`re-anchor on cancel failed: ${String(err)}`);
    }
    state.currentWorktree = null;
    state.currentSession = null;
    state.currentTicket = null;
    state.status = "idle";
    state.pendingRecycle = false;
  }

  // Recycle the slot once the current session has actually ended (idle/error).
  // Called from the event hook; keeps the claim loop from grabbing the next task
  // while this session is still committing.
  async function recycleSlot() {
    try {
      await returnToRepoRoot(realGit, cfg.repoRoot);
    } catch (err) {
      log(`re-anchor on recycle failed: ${String(err)}`);
    }
    state.currentSession = null;
    state.currentTicket = null;
    state.currentWorktree = null;
    state.status = "idle";
    state.pendingRecycle = false;
  }

  function startPolling() {
    if (pollStarted) return;
    pollStarted = true;
    void pollLoop({
      client: http,
      config: cfg,
      state,
      git: realGit,
      log,
      logVerbose,
      dispatchPrompt,
      onReply,
      onCancel,
      onMessage,
    });
  }

  // Headless enlistment (ALMADEL_JOIN + ALMADEL_TOKEN) happens at startup.
  if (hasEnvEnlistment(cfg)) {
    log(`enlisting headless: project=${cfg.project} label=${cfg.label}`);
    try {
      await enlist({ server: cfg.serverUrl, project: cfg.project, label: cfg.label });
    } catch (err) {
      log(`headless enlist failed: ${String(err)}`);
    }
  }

  const tools = await makeAlmadelTools({
    client: http,
    state,
    git: realGit,
    repoRoot: cfg.repoRoot,
    enlist,
    leave,
    status,
    getBoard: async () => {
      if (!state.projectId) return [];
      const board = await http.getBoard(state.projectId);
      state.board = board;
      return board.columns.map((c) => ({ id: c.id, name: c.name }));
    },
  });

  return {
    tool: tools as never,

    event: async ({ event }) => {
      const e = event as { type?: string; properties?: unknown };
      if (e.type === "permission.asked") {
        const parsed = PermissionRequestSchema.safeParse(e.properties);
        if (!parsed.success) {
          log(`permission.asked with unexpected shape: ${parsed.error.message}`);
          return;
        }
        const req = parsed.data;
        const reply = await decidePermission(http, state, req);
        await client.postSessionIdPermissionsPermissionId({
          path: { id: req.sessionID, permissionID: req.id },
          body: { response: reply.response },
        });
        pipeline?.enqueue("permission.asked", req);
        log(`permission ${req.permission} -> ${reply.response}`);
        return;
      }
      if (e.type === "permission.replied") {
        pipeline?.enqueue("permission.replied", e.properties);
        return;
      }
      if (e.type === "session.error" || e.type === "session.idle") {
        if (state.pendingRecycle) {
          await recycleSlot();
        }
        pipeline?.enqueue(e.type, e.properties);
        return;
      }
      pipeline?.enqueue(e.type ?? "unknown", e.properties);
    },

    config: async (c) => {
      // Slash commands are static templates; each points the model at the tool
      // that actually performs the action.
      c.command = {
        ...(c.command ?? {}),
        "almadel:join": {
          template:
            "Join this agent to an Almadel server. Determine the server URL and project name from the user's message, then call the almadel_join tool with the server and project arguments. If the user supplied a token or label, pass those too.",
          description: "Join an Almadel board as a worker",
        },
        "almadel:status": {
          template:
            "Report this agent's Almadel worker status by calling the almadel_status tool and summarizing its output.",
          description: "Show Almadel worker status",
        },
        "almadel:leave": {
          template:
            "Deregister this agent from the Almadel server by calling the almadel_leave tool and report the result.",
          description: "Leave the Almadel board",
        },
      };
    },
  };
};

export default AlmadelPlugin;
