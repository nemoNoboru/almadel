import { z } from "zod"

// Domain types shared with the web frontend and the opencode plugin.
// Mirrors plan/02-data-model.md and the browser-facing API (plan/03-api-surface.md).

export type TicketState =
  | "ready"
  | "running"
  | "blocked_question"
  | "blocked_permission"
  | "done"
  | "failed"

export type AgentStatus =
  | "idle"
  | "working"
  | "blocked_question"
  | "blocked_permission"
  | "failed"

export type CommentAuthor = "human" | "agent" | "system"

export type CommentKind =
  | "comment"
  | "plan"
  | "question"
  | "answer"
  | "permission"
  | "move"

export type PermissionDecision = "allow" | "deny"
export type PermissionScope = "once" | "always" | "session"

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

export interface Comment {
  id: number
  ticket_id: string
  author: CommentAuthor
  kind: CommentKind
  body: string | null
  created_at: number
  updated_at: number | null
}

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
  port_base: number | null
}

export interface Permission {
  id: string
  ticket_id: string
  tool: string | null
  command: string | null
  decision: PermissionDecision | null
  scope: PermissionScope | null
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

export type MessageAuthor = "human" | "agent"

export interface Message {
  id: number
  agent_id: string
  author: MessageAuthor
  body: string
  created_at: number
}

export interface RosterProject {
  project: Project
  agents: (Agent & { online: boolean })[]
}

export interface Roster {
  projects: RosterProject[]
  needs_you: number
}

export interface Board {
  project: Project
  columns: Column[]
  tickets: Ticket[]
}

export interface TicketThread {
  ticket: Ticket
  comments: Comment[]
  question: Question | null
  permission: Permission | null
  pending: PendingMessage[]
}

// The claim union (§8). New tickets, replies into held sessions, and permission
// decisions all arrive through this one channel.
export type Job =
  | { type: "task"; project: string; ticket: string; prompt: string; branch: string }
  | { type: "reply"; project: string; ticket: string; text: string }
  | { type: "permission"; project: string; ticket: string; permission_id: string; decision: PermissionDecision; scope: PermissionScope }
  | { type: "cancel"; project: string; ticket: string }
  | { type: "message"; project: string; text: string }

// ---------------------------------------------------------------------------
// Zod schemas for request validation (shared contract)
// ---------------------------------------------------------------------------

export const registrationSchema = z.object({
  project: z.string().min(1),
  repo_root: z.string().min(1),
  git_remote: z.string().optional(),
  default_branch: z.string().optional(),
  label: z.string().optional(),
  opencode_version: z.string().optional(),
  capabilities: z
    .object({
      tools: z.boolean(),
      permission_hook: z.boolean(),
    })
    .partial()
    .optional(),
})

export const claimBodySchema = z.object({
  project: z.string().min(1),
  agent: z.string().min(1),
  slot: z
    .object({
      status: z.string(),
      ticket: z.string().nullable().optional(),
      since: z.number().nullable().optional(),
    })
    .optional(),
})

export const createTicketSchema = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  column_id: z.string().min(1),
})

export const moveTicketSchema = z.object({
  column: z.string().min(1),
  note: z.string().max(2000).optional(),
})

export const commentSchema = z.object({
  kind: z.enum(["comment", "plan", "question", "answer", "permission", "move"]),
  body: z.string().optional(),
})

export const askSchema = z.object({ question: z.string().min(1).max(4000) })

export const replySchema = z.object({ body: z.string().min(1) })

export const commentUpdateSchema = z.object({ body: z.string().min(1).max(20000) })

export const messageSchema = z.object({ body: z.string().min(1) })

export const permissionDecisionSchema = z.object({
  decision: z.enum(["allow", "deny"]),
  scope: z.enum(["once", "always", "session"]),
})

export const permissionRequestSchema = z.object({
  tool: z.string().optional(),
  command: z.string().optional(),
})

export const eventBatchSchema = z.object({
  events: z
    .array(
      z.object({
        kind: z.string().min(1),
        payload: z.unknown(),
      }),
    )
    .max(1000),
})

export const columnInputSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  prompt: z.string().nullable(),
  next_column: z.string().nullable(),
  fail_column: z.string().nullable(),
  wip_limit: z.number().nullable(),
})

export const columnsPutSchema = z.object({ columns: z.array(columnInputSchema) })

export const draftSchema = z.object({
  project_id: z.string().min(1),
  agent_id: z.string().min(1),
  instruction: z.string().min(1),
})
