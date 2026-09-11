// Domain types shared across the frontend, mirroring the server data model
// (plan/02-data-model.md) and the browser-facing API (plan/03-api-surface.md).

export interface Project {
  id: string
  name: string
  git_remote: string | null
  default_branch: string
  created_at: number
}

export interface Column {
  id: string
  project_id: string
  name: string
  position: number
  prompt: string | null // NULL = human gate
  next_column: string | null
  fail_column: string | null
  wip_limit: number | null
}

export type TicketState =
  | "ready"
  | "running"
  | "blocked_question"
  | "blocked_permission"
  | "done"
  | "failed"

export interface Ticket {
  id: string
  project_id: string
  title: string
  body: string | null
  column_id: string
  state: TicketState
  branch: string | null
  agent_id: string | null
  priority: number
  claimed_at: number | null
  created_at: number
}

export type CommentAuthor = "human" | "agent" | "system"

export type CommentKind =
  | "comment"
  | "plan"
  | "question"
  | "answer"
  | "permission"
  | "move"

export interface Comment {
  id: number
  ticket_id: string
  author: CommentAuthor
  kind: CommentKind
  body: string | null
  created_at: number
  updated_at: number | null
}

export type AgentStatus =
  | "idle"
  | "working"
  | "blocked_question"
  | "blocked_permission"
  | "failed"

export interface Agent {
  id: string
  project_id: string
  name: string | null
  label: string | null
  repo_root: string | null
  status: AgentStatus
  ticket_id: string | null
  since: number | null
  last_poll: number | null
  opencode_version: string | null
  registered_at: number
  // Derived on the server (presence is never stored — plan/02-data-model.md)
  online: boolean
}

export interface RosterProject {
  project: Project
  agents: Agent[]
}

export interface Roster {
  projects: RosterProject[]
  needs_you: number
}

export interface Permission {
  id: string
  ticket_id: string
  tool: string | null
  command: string | null
  decision: "allow" | "deny" | null
  scope: "once" | "always" | "session" | null
  created_at: number
  decided_at: number | null
}

export interface Question {
  id: string
  ticket_id: string
  body: string
  answer: string | null
  deferred: boolean
  created_at: number
  answered_at: number | null
}

export interface PendingMessage {
  id: number
  ticket_id: string
  body: string
  created_at: number
  sent_at: number | null
}

export interface EventItem {
  seq: number
  kind: string
  payload: string
  created_at: number
}

// A ticket plus its full comment thread (the conversation view).
export interface TicketThread {
  ticket: Ticket
  comments: Comment[]
  question: Question | null
  permission: Permission | null
  pending: PendingMessage[]
}

// Board payload: one project's columns and tickets.
export interface Board {
  project: Project
  columns: Column[]
  tickets: Ticket[]
}
