import type { Board, Roster, TicketThread } from "@/types/domain"

export type PermissionDecision = "allow" | "deny"
export type PermissionScope = "once" | "always" | "session"

export interface CreateTicketInput {
  project_id: string
  title: string
  body: string
  column_id: string
}

export interface ColumnInput {
  name: string
  prompt: string | null
  next_column: string | null
  fail_column: string | null
  wip_limit: number | null
}

export interface MoveTicketInput {
  column: string
  note?: string
}

export interface DraftTicketInput {
  project_id: string
  agent_id: string
  instruction: string
}

export interface TicketDraft {
  title: string
  body: string
  agent_name: string
}

export interface Message {
  id: number
  agent_id: string
  author: "human" | "agent"
  body: string
  created_at: number
}

// A signal that *something changed*; the UI re-fetches the relevant query
// ("the query is the truth" — plan/frontend/07-events-and-live-log.md).
export type StreamEvent =
  | { type: "roster" }
  | { type: "ticket"; ticket_id: string }
  | { type: "board"; project_id: string }

export interface SubscribeHandle {
  unsubscribe: () => void
}

export interface AlmadelClient {
  // Queries
  getRoster(): Promise<Roster>
  getBoard(projectId: string): Promise<Board>
  getTicketThread(ticketId: string): Promise<TicketThread>
  listProjects(): Promise<{ id: string; name: string }[]>
  listMessages(agentId: string): Promise<Message[]>

  // Mutations
  createTicket(input: CreateTicketInput): Promise<void>
  draftTicket(input: DraftTicketInput): Promise<TicketDraft>
  moveTicket(ticketId: string, input: MoveTicketInput): Promise<void>
  reply(ticketId: string, body: string): Promise<void>
  updateComment(ticketId: string, commentId: number, body: string): Promise<void>
  decidePermission(
    ticketId: string,
    decision: PermissionDecision,
    scope: PermissionScope,
  ): Promise<void>
  cancelTicket(ticketId: string): Promise<void>
  takeoverTicket(ticketId: string): Promise<void>
  updateColumns(projectId: string, columns: ColumnInput[]): Promise<void>
  sendMessage(agentId: string, body: string): Promise<void>

  // Realtime
  subscribe(onEvent: (e: StreamEvent) => void): SubscribeHandle
  subscribeTicket(
    ticketId: string,
    onEvent: (e: StreamEvent) => void,
  ): SubscribeHandle
}

export class ApiError extends Error {
  readonly status: number
  readonly issues: Array<{ path: string; message: string }>

  constructor(status: number, message: string, issues: ApiError["issues"] = []) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.issues = issues
  }
}
