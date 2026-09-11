import type {
  AgentStatus,
  Board,
  PermissionRequest,
  Ticket,
} from "./types.ts";

export interface PendingPermission {
  sessionID: string;
  permissionID: string;
  ticket: string;
  resolve: (decision: { response: "once" | "always" | "reject" }) => void;
}

export interface PendingQuestion {
  ticket: string;
  questionID: string;
  resolve: (answer: string) => void;
}

export interface AlmadelState {
  serverUrl: string | null;
  projectId: string | null;
  agentId: string | null;
  token: string | null;
  currentTicket: string | null;
  currentSession: string | null;
  currentModel: string | null;
  currentWorktree: string | null;
  status: AgentStatus;
  board: Board | null;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  running: boolean;
}

export function createState(): AlmadelState {
  return {
    serverUrl: null,
    projectId: null,
    agentId: null,
    token: null,
    currentTicket: null,
    currentSession: null,
    currentModel: null,
    currentWorktree: null,
    status: "idle",
    board: null,
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    running: false,
  };
}
