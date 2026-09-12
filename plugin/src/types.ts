import { z } from "zod";

export const TicketState = z.enum([
  "ready",
  "running",
  "blocked_question",
  "blocked_permission",
  "done",
  "failed",
]);
export type TicketState = z.infer<typeof TicketState>;

export const AgentStatus = z.enum([
  "idle",
  "working",
  "blocked_question",
  "blocked_permission",
  "failed",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const CommentKind = z.enum([
  "comment",
  "plan",
  "question",
  "answer",
  "permission",
  "move",
]);
export type CommentKind = z.infer<typeof CommentKind>;

export const PermissionDecision = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PermissionScope = z.enum(["once", "always", "session"]);
export type PermissionScope = z.infer<typeof PermissionScope>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ColumnSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  prompt: z.string().nullable(),
  position: z.number(),
});
export type Column = z.infer<typeof ColumnSchema>;

export const TicketSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  column_id: z.string().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  state: TicketState,
  agent_id: z.string().nullable(),
  branch: z.string().nullable(),
  claimed_at: z.string().nullable(),
  created_at: z.string(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  ticket_id: z.string(),
  author: z.enum(["human", "agent", "system"]),
  kind: CommentKind,
  body: z.string().nullable(),
  created_at: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const BoardSchema = z.object({
  project: ProjectSchema,
  columns: z.array(ColumnSchema),
  tickets: z.array(TicketSchema),
});
export type Board = z.infer<typeof BoardSchema>;

export const TicketThreadSchema = z.object({
  ticket: TicketSchema,
  comments: z.array(CommentSchema),
  question: z.any().nullable(),
  permission: z.any().nullable(),
  pending: z.array(z.any()),
});
export type TicketThread = z.infer<typeof TicketThreadSchema>;

// ---- wire schemas (mirror server/src/types.ts) ----

export const registrationSchema = z.object({
  project: z.string().min(1),
  repo_root: z.string().min(1),
  git_remote: z.string().optional(),
  default_branch: z.string().optional(),
  label: z.string().optional(),
  opencode_version: z.string().optional(),
  capabilities: z
    .object({
      tools: z.boolean().optional(),
      permission_hook: z.boolean().optional(),
    })
    .optional(),
});
export type RegistrationInput = z.infer<typeof registrationSchema>;

export const RegistrationResultSchema = z.object({
  agent_id: z.string(),
  name: z.string(),
  token: z.string(),
  port_base: z.number(),
});
export type RegistrationResult = z.infer<typeof RegistrationResultSchema>;

export const slotSchema = z.object({
  status: AgentStatus,
  ticket: z.string().nullable().optional(),
  since: z.number().optional(),
});
export type Slot = z.infer<typeof slotSchema>;

export const claimBodySchema = z.object({
  project: z.string().min(1),
  agent: z.string().min(1),
  slot: slotSchema.optional(),
});
export type ClaimBody = z.infer<typeof claimBodySchema>;

export const TaskJobSchema = z.object({
  type: z.literal("task"),
  project: z.string(),
  ticket: z.string(),
  prompt: z.string(),
  branch: z.string(),
});

export const ReplyJobSchema = z.object({
  type: z.literal("reply"),
  project: z.string(),
  ticket: z.string(),
  text: z.string(),
});

export const PermissionJobSchema = z.object({
  type: z.literal("permission"),
  project: z.string(),
  ticket: z.string(),
  permission_id: z.string(),
  decision: PermissionDecision,
  scope: PermissionScope,
});

export const CancelJobSchema = z.object({
  type: z.literal("cancel"),
  project: z.string(),
  ticket: z.string(),
});

export const MessageJobSchema = z.object({
  type: z.literal("message"),
  project: z.string(),
  text: z.string(),
});

export const JobSchema = z.discriminatedUnion("type", [
  TaskJobSchema,
  ReplyJobSchema,
  PermissionJobSchema,
  CancelJobSchema,
  MessageJobSchema,
]);
export type Job = z.infer<typeof JobSchema>;

export const moveTicketSchema = z.object({
  column: z.string().min(1),
  note: z.string().max(2000).optional(),
});
export type MoveTicketInput = z.infer<typeof moveTicketSchema>;

export const createTicketSchema = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  column_id: z.string().min(1),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const commentSchema = z.object({
  kind: CommentKind,
  body: z.string().optional(),
});
export type CommentInput = z.infer<typeof commentSchema>;

export const askSchema = z.object({
  question: z.string().min(1).max(4000),
});
export type AskInput = z.infer<typeof askSchema>;

export const replySchema = z.object({
  body: z.string().min(1),
});
export type ReplyInput = z.infer<typeof replySchema>;

export const permissionRequestSchema = z.object({
  tool: z.string().optional(),
  command: z.string().optional(),
});
export type PermissionRequestInput = z.infer<typeof permissionRequestSchema>;

export const permissionRequestResultSchema = z.union([
  z.object({
    decision: PermissionDecision,
    scope: PermissionScope,
  }),
  z.object({
    decision: z.literal("deny"),
    scope: z.literal("once"),
    timeout: z.literal(true),
  }),
]);
export type PermissionRequestResult = z.infer<typeof permissionRequestResultSchema>;

export const eventItemSchema = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
});
export const eventBatchSchema = z.object({
  events: z.array(eventItemSchema).max(1000),
});
export type EventItem = z.infer<typeof eventItemSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;

// ---- runtime PermissionRequest (vendored from opencode 1.18.30) ----

export const PermissionRequestSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  permission: z.string(),
  patterns: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  always: z.array(z.string()),
  tool: z
    .object({
      messageID: z.string(),
      callID: z.string(),
    })
    .optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;
