import type {
  Agent,
  Board,
  Column,
  Comment,
  Permission,
  PendingMessage,
  Project,
  Question,
  Roster,
  Ticket,
  TicketState,
  TicketThread,
} from "@/types/domain"
import {
  agents as seedAgents,
  columns as seedColumns,
  comments as seedComments,
  pendingMessages as seedPending,
  permissions as seedPermissions,
  projects as seedProjects,
  questions as seedQuestions,
  tickets as seedTickets,
} from "./seed"

const LEASE_TTL = 90_000

// Deep-copy the seed arrays so the store is isolated per load.
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

class Store {
  projects: Project[] = clone(seedProjects)
  columns: Column[] = clone(seedColumns)
  tickets: Ticket[] = clone(seedTickets)
  agents: Agent[] = clone(seedAgents)
  comments: Comment[] = clone(seedComments)
  questions: Question[] = clone(seedQuestions)
  permissions: Permission[] = clone(seedPermissions)
  pending: PendingMessage[] = clone(seedPending)

  private nextCommentId = 100
  private nextTicketNum = 430
  private nextQuestionId = 100

  // ---- derived reads -------------------------------------------------------

  isOnline(agent: Agent): boolean {
    if (agent.last_poll == null) return false
    return Date.now() - agent.last_poll < LEASE_TTL
  }

  roster(): Roster {
    const projects = this.projects
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({
        project,
        agents: this.agents
          .filter((a) => a.project_id === project.id)
          .map((a) => ({ ...a, online: this.isOnline(a) }))
          .sort((a, b) => statusSeverity(b) - statusSeverity(a)),
      }))

    return {
      projects,
      needs_you: this.tickets.filter((t) => t.state.startsWith("blocked")).length,
    }
  }

  board(projectId: string): Board {
    const project = this.projects.find((p) => p.id === projectId)
    if (!project) throw new Error(`project not found: ${projectId}`)

    const columns = this.columns
      .filter((c) => c.project_id === projectId)
      .sort((a, b) => a.position - b.position)

    const tickets = this.tickets
      .filter((t) => t.project_id === projectId)
      .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at)

    return { project, columns, tickets }
  }

  thread(ticketId: string): TicketThread {
    const ticket = this.tickets.find((t) => t.id === ticketId)
    if (!ticket) throw new Error(`ticket not found: ${ticketId}`)

    const comments = this.comments
      .filter((c) => c.ticket_id === ticketId)
      .sort((a, b) => a.created_at - b.created_at)

    const question =
      this.questions.find((q) => q.ticket_id === ticketId) ?? null
    const permission =
      this.permissions.find((p) => p.ticket_id === ticketId) ?? null
    const pending = this.pending
      .filter((p) => p.ticket_id === ticketId)
      .sort((a, b) => a.created_at - b.created_at)

    return { ticket, comments, question, permission, pending }
  }

  // ---- mutations -----------------------------------------------------------

  createTicket(projectId: string, title: string, body: string, columnId: string): void {
    const id = `TCK-${this.nextTicketNum++}`
    const ticket: Ticket = {
      id,
      project_id: projectId,
      title,
      body: body || null,
      column_id: columnId,
      state: "ready",
      branch: null,
      agent_id: null,
      priority: 0,
      claimed_at: null,
      created_at: Date.now(),
    }
    this.tickets.push(ticket)
  }

  moveTicket(ticketId: string, columnId: string, note?: string): void {
    const ticket = this.tickets.find((t) => t.id === ticketId)
    if (!ticket) throw new Error(`ticket not found: ${ticketId}`)

    const column = this.columns.find((c) => c.id === columnId)
    if (!column || column.project_id !== ticket.project_id) {
      throw new Error("out of scope")
    }

    // WIP enforcement: a prompted column with a limit reached rejects a drop.
    if (column.wip_limit != null) {
      const inColumn = this.tickets.filter(
        (t) => t.column_id === columnId && t.state === "running",
      ).length
      if (inColumn >= column.wip_limit) {
        throw new Error(`wip_limit reached for ${column.name}`)
      }
    }

    ticket.column_id = columnId
    ticket.state = column.prompt != null ? "ready" : "done"
    ticket.agent_id = null

    this.comments.push({
      id: this.nextCommentId++,
      ticket_id: ticketId,
      author: "system",
      kind: "move",
      body: note ? `moved to ${column.name}: ${note}` : `moved to ${column.name}`,
      created_at: Date.now(),
      updated_at: null,
    })
  }

  reply(ticketId: string, body: string): void {
    const ticket = this.tickets.find((t) => t.id === ticketId)
    if (!ticket) throw new Error(`ticket not found: ${ticketId}`)

    this.comments.push({
      id: this.nextCommentId++,
      ticket_id: ticketId,
      author: "human",
      kind: "answer",
      body,
      created_at: Date.now(),
      updated_at: null,
    })

    const question = this.questions.find((q) => q.ticket_id === ticketId)
    if (question) {
      question.answer = body
      question.answered_at = Date.now()
    }

    // Resuming a blocked agent puts it back to running.
    if (ticket.state === "blocked_question") {
      ticket.state = "running"
      const agent = this.agents.find((a) => a.id === ticket.agent_id)
      if (agent) agent.status = "working"
    } else if (ticket.state === "running") {
      // Nudge: queue as a pending message delivered when the turn ends.
      this.pending.push({
        id: Date.now(),
        ticket_id: ticketId,
        body,
        created_at: Date.now(),
        sent_at: null,
      })
    }
  }

  updateComment(ticketId: string, commentId: number, body: string): void {
    const comment = this.comments.find((c) => c.id === commentId && c.ticket_id === ticketId)
    if (!comment) throw new Error(`comment not found: ${commentId}`)
    if (comment.author === "system") throw new Error("system comments are not editable")
    comment.body = body
    comment.updated_at = Date.now()
  }

  decidePermission(
    ticketId: string,
    decision: "allow" | "deny",
    scope: "once" | "always" | "session",
  ): void {
    const ticket = this.tickets.find((t) => t.id === ticketId)
    if (!ticket) throw new Error(`ticket not found: ${ticketId}`)

    const permission = this.permissions.find((p) => p.ticket_id === ticketId)
    if (permission) {
      permission.decision = decision
      permission.scope = scope
      permission.decided_at = Date.now()
    }

    this.comments.push({
      id: this.nextCommentId++,
      ticket_id: ticketId,
      author: "human",
      kind: "permission",
      body: `${decision === "allow" ? "Allowed" : "Denied"} ${permission?.command ?? ""} (${scope})`,
      created_at: Date.now(),
      updated_at: null,
    })

    if (ticket.state === "blocked_permission") {
      ticket.state = "running"
      const agent = this.agents.find((a) => a.id === ticket.agent_id)
      if (agent) agent.status = "working"
    }
  }

  cancelTicket(ticketId: string): void {
    const ticket = this.tickets.find((t) => t.id === ticketId)
    if (!ticket) throw new Error(`ticket not found: ${ticketId}`)

    ticket.state = "failed"
    ticket.agent_id = null

    this.comments.push({
      id: this.nextCommentId++,
      ticket_id: ticketId,
      author: "system",
      kind: "move",
      body: "cancelled by human",
      created_at: Date.now(),
      updated_at: null,
    })
  }

  takeoverTicket(ticketId: string): void {
    const ticket = this.tickets.find((t) => t.id === ticketId)
    if (!ticket) throw new Error(`ticket not found: ${ticketId}`)

    ticket.agent_id = null
    ticket.state = "ready"

    this.comments.push({
      id: this.nextCommentId++,
      ticket_id: ticketId,
      author: "system",
      kind: "move",
      body: "taken over by human (branch left in place)",
      created_at: Date.now(),
      updated_at: null,
    })
  }

  updateColumns(projectId: string, inputs: Array<Partial<Column>>): void {
    this.columns = this.columns.filter((c) => c.project_id !== projectId)
    const kept = this.columns

    const updated: Column[] = inputs.map((input, i) => ({
      id: input.id ?? `col-${projectId}-${i}-${Date.now()}`,
      project_id: projectId,
      name: input.name ?? "Column",
      position: i,
      prompt: input.prompt ?? null,
      next_column: input.next_column ?? null,
      fail_column: input.fail_column ?? null,
      wip_limit: input.wip_limit ?? null,
    }))

    this.columns = [...kept, ...updated]
  }

  // ---- simulated live activity (mock only) ---------------------------------

  simulateQuestion(ticketId: string, body: string): void {
    const ticket = this.tickets.find((t) => t.id === ticketId)
    if (!ticket) return
    ticket.state = "blocked_question"
    const agent = this.agents.find((a) => a.id === ticket.agent_id)
    if (agent) agent.status = "blocked_question"

    this.questions.push({
      id: `q_${this.nextQuestionId++}`,
      ticket_id: ticketId,
      body,
      answer: null,
      deferred: false,
      created_at: Date.now(),
      answered_at: null,
    })

    this.comments.push({
      id: this.nextCommentId++,
      ticket_id: ticketId,
      author: "agent",
      kind: "question",
      body,
      created_at: Date.now(),
      updated_at: null,
    })
  }

  simulatePermission(ticketId: string, command: string): void {
    const ticket = this.tickets.find((t) => t.id === ticketId)
    if (!ticket) return
    ticket.state = "blocked_permission"
    const agent = this.agents.find((a) => a.id === ticket.agent_id)
    if (agent) agent.status = "blocked_permission"

    this.permissions.push({
      id: `prm_${this.nextCommentId++}`,
      ticket_id: ticketId,
      tool: "bash",
      command,
      decision: null,
      scope: null,
      created_at: Date.now(),
      decided_at: null,
    })
  }
}

function statusSeverity(agent: Agent): number {
  if (agent.status.startsWith("blocked")) return 3
  if (agent.status === "working") return 2
  if (agent.status === "idle") return 1
  return 0
}

export { Store }
export type { TicketState }
