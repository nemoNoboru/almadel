import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { ThemeProvider } from "next-themes"
import { render } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppContext, type AppState } from "@/state/AppProvider"
import type {
  Agent,
  Board,
  Column,
  Comment,
  Project,
  Roster,
  Ticket,
  TicketThread,
} from "@/types/domain"

// ---- fixtures --------------------------------------------------------------

export const project: Project = {
  id: "almadel-api",
  name: "almadel-api",
  git_remote: "git@github.com:me/almadel-api.git",
  default_branch: "main",
  created_at: 1,
}

export const columns: Column[] = [
  {
    id: "col-spec",
    project_id: "almadel-api",
    name: "Spec",
    position: 0,
    prompt: null,
    next_column: "col-planning",
    fail_column: null,
    wip_limit: null,
  },
  {
    id: "col-planning",
    project_id: "almadel-api",
    name: "Planning",
    position: 1,
    prompt: "Read ticket {{ticket.id}}.",
    next_column: "col-review",
    fail_column: "col-failed",
    wip_limit: 2,
  },
  {
    id: "col-done",
    project_id: "almadel-api",
    name: "Done",
    position: 2,
    prompt: null,
    next_column: null,
    fail_column: null,
    wip_limit: null,
  },
]

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "TCK-1",
    project_id: "almadel-api",
    title: "A ticket",
    body: null,
    column_id: "col-spec",
    state: "ready",
    branch: null,
    agent_id: null,
    priority: 0,
    claimed_at: null,
    created_at: 1,
    ...overrides,
  }
}

export const tickets: Ticket[] = [
  makeTicket({ id: "TCK-1", title: "Spec ticket", column_id: "col-spec" }),
  makeTicket({
    id: "TCK-2",
    title: "Running ticket",
    column_id: "col-planning",
    state: "running",
    agent_id: "agt-1",
    branch: "run/TCK-2",
  }),
  makeTicket({
    id: "TCK-3",
    title: "Blocked question",
    column_id: "col-planning",
    state: "blocked_question",
    agent_id: "agt-2",
  }),
]

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agt-1",
    project_id: "almadel-api",
    name: "Alimiel",
    label: "laptop",
    repo_root: null,
    status: "idle",
    ticket_id: null,
    since: null,
    last_poll: Date.now(),
    opencode_version: null,
    registered_at: 1,
    online: true,
    ...overrides,
  }
}

export const agents: Agent[] = [
  makeAgent({ id: "agt-1", name: "Alimiel", status: "working", ticket_id: "TCK-2" }),
  makeAgent({
    id: "agt-2",
    name: "Gediel",
    status: "blocked_question",
    ticket_id: "TCK-3",
  }),
  makeAgent({ id: "agt-3", name: "Barachiel", status: "idle" }),
]

export const roster: Roster = {
  projects: [{ project, agents }],
  needs_you: 1,
}

export const board: Board = { project, columns, tickets }

export function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    ticket_id: "TCK-3",
    author: "agent",
    kind: "question",
    body: "Which backend?",
    created_at: 1,
    updated_at: null,
    ...overrides,
  }
}

export function makeThread(overrides: Partial<TicketThread> = {}): TicketThread {
  return {
    ticket: makeTicket({ id: "TCK-3", state: "blocked_question", agent_id: "agt-2" }),
    comments: [makeComment()],
    question: {
      id: "q-1",
      ticket_id: "TCK-3",
      body: "Which backend?",
      answer: null,
      deferred: false,
      created_at: 1,
      answered_at: null,
    },
    permission: null,
    pending: [],
    ...overrides,
  }
}

// ---- AppState factory ------------------------------------------------------

export function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    projects: [{ id: project.id, name: project.name }],
    roster,
    board,
    selectedProjectId: project.id,
    selectedTicketId: null,
    selectedAgentId: null,
    thread: null,
    messages: [],
    loadingRoster: false,
    loadingBoard: false,
    loadingThread: false,
    loadingMessages: false,
    error: null,
    selectProject: () => {},
    selectTicket: () => {},
    selectAgent: () => {},
    closeConversation: () => {},
    closeAgentChat: () => {},
    sendAgentMessage: async () => {},
    moveTicket: async () => {},
    createTicket: async () => {},
    reply: async () => {},
    updateComment: async () => {},
    decidePermission: async () => {},
    cancel: async () => {},
    takeover: async () => {},
    updateColumns: async () => {},
    ...overrides,
  }
}

// ---- render helper ---------------------------------------------------------

export function renderWithApp(
  ui: ReactNode,
  state: AppState = makeState(),
  initialEntries: string[] = ["/"],
) {
  return render(
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <TooltipProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <AppContext.Provider value={state}>{ui}</AppContext.Provider>
        </MemoryRouter>
      </TooltipProvider>
    </ThemeProvider>,
  )
}
