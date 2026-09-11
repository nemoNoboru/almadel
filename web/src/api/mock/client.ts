import type { AlmadelClient, Message, StreamEvent, SubscribeHandle } from "../client"
import { ApiError } from "../client"
import { Store } from "./store"

type Listener = (e: StreamEvent) => void

// A simulated latency + error surface so the UI behaves against a
// mock the way it will against the real HTTP API.
const LATENCY_MS = 120

function delay(ms = LATENCY_MS) {
  return new Promise((r) => setTimeout(r, ms))
}

// A rough, deterministic draft generator so the mock has something to return.
function draftFromInstruction(instruction: string): { title: string; body: string } {
  const text = instruction.trim()
  const firstLine = text.split(/\r?\n/)[0] ?? text
  const clipped = firstLine.replace(/[.!?]+$/, "").trim()
  const title =
    clipped.length > 80
      ? clipped.slice(0, 80).replace(/\s+\S*$/, "") + "…"
      : clipped || "Untitled card"

  const body = [
    "## Context",
    text,
    "",
    "## Scope",
    "Implement the change described above, on a dedicated branch.",
    "",
    "## Acceptance criteria",
    "- [ ] Tests pass",
    "- [ ] Reviewed in the thread before moving on",
  ].join("\n")

  return { title, body }
}

export class MockClient implements AlmadelClient {
  private store = new Store()
  private listeners = new Set<Listener>()
  private liveTimer: ReturnType<typeof setInterval> | null = null
  private messages = new Map<string, Message[]>()

  private emit(e: StreamEvent) {
    for (const l of this.listeners) l(e)
  }

  private broadcastRoster() {
    this.emit({ type: "roster" })
  }

  private broadcastBoard(projectId: string) {
    this.emit({ type: "board", project_id: projectId })
  }

  private broadcastTicket(ticketId: string) {
    this.emit({ type: "ticket", ticket_id: ticketId })
  }

  async getRoster() {
    await delay()
    return this.store.roster()
  }

  async getBoard(projectId: string) {
    await delay()
    return this.store.board(projectId)
  }

  async getTicketThread(ticketId: string) {
    await delay()
    try {
      return this.store.thread(ticketId)
    } catch {
      throw new ApiError(404, "ticket not found")
    }
  }

  async listProjects() {
    await delay()
    return this.store.projects.map((p) => ({ id: p.id, name: p.name }))
  }

  async listMessages(agentId: string) {
    await delay()
    return this.messages.get(agentId) ?? []
  }

  async sendMessage(agentId: string, body: string) {
    await delay()
    const list = this.messages.get(agentId) ?? []
    const id = list.length + 1
    list.push({ id, agent_id: agentId, author: "human", body, created_at: Date.now() })
    this.messages.set(agentId, list)
    // Simulate the agent replying shortly after.
    setTimeout(() => {
      const current = this.messages.get(agentId) ?? []
      current.push({
        id: current.length + 1,
        agent_id: agentId,
        author: "agent",
        body: `[mock reply] ${body}`,
        created_at: Date.now(),
      })
      this.messages.set(agentId, current)
    }, 1500)
  }

  async createTicket(input: {
    project_id: string
    title: string
    body: string
    column_id: string
  }) {
    await delay()
    this.store.createTicket(
      input.project_id,
      input.title,
      input.body,
      input.column_id,
    )
    this.broadcastBoard(input.project_id)
  }

  async draftTicket(input: {
    project_id: string
    agent_id: string
    instruction: string
  }) {
    const agent = this.store.agents.find((a) => a.id === input.agent_id)
    if (agent) {
      agent.status = "working"
      this.broadcastRoster()
    }
    // Simulate the agent thinking, then drafting the card.
    await delay(1600)
    const draft = draftFromInstruction(input.instruction)
    if (agent) {
      agent.status = "idle"
      this.broadcastRoster()
    }
    return { ...draft, agent_name: agent?.name ?? "agent" }
  }

  async moveTicket(ticketId: string, input: { column: string; note?: string }) {
    await delay()
    const ticket = this.store.tickets.find((t) => t.id === ticketId)
    try {
      this.store.moveTicket(ticketId, input.column, input.note)
    } catch (err) {
      throw new ApiError(400, err instanceof Error ? err.message : "bad request")
    }
    if (ticket) this.broadcastBoard(ticket.project_id)
    this.broadcastTicket(ticketId)
  }

  async reply(ticketId: string, body: string) {
    await delay()
    this.store.reply(ticketId, body)
    this.broadcastTicket(ticketId)
    this.broadcastRoster()
  }

  async decidePermission(
    ticketId: string,
    decision: "allow" | "deny",
    scope: "once" | "always" | "session",
  ) {
    await delay()
    this.store.decidePermission(ticketId, decision, scope)
    this.broadcastTicket(ticketId)
    this.broadcastRoster()
  }

  async cancelTicket(ticketId: string) {
    await delay()
    this.store.cancelTicket(ticketId)
    this.broadcastTicket(ticketId)
    this.broadcastRoster()
  }

  async takeoverTicket(ticketId: string) {
    await delay()
    this.store.takeoverTicket(ticketId)
    this.broadcastTicket(ticketId)
    this.broadcastRoster()
  }

  async updateColumns(projectId: string, columns: Array<Partial<{ id: string; name: string; prompt: string | null; next_column: string | null; fail_column: string | null; wip_limit: number | null }>>) {
    await delay()
    this.store.updateColumns(projectId, columns)
    this.broadcastBoard(projectId)
  }

  subscribe(onEvent: Listener): SubscribeHandle {
    this.listeners.add(onEvent)
    this.startLiveLoop()
    return {
      unsubscribe: () => {
        this.listeners.delete(onEvent)
        this.stopLiveLoop()
      },
    }
  }

  subscribeTicket(_ticketId: string, onEvent: Listener): SubscribeHandle {
    // Mock ticket stream: deliver any ticket-scoped events the same loop emits.
    this.listeners.add(onEvent)
    this.startLiveLoop()
    return {
      unsubscribe: () => {
        this.listeners.delete(onEvent)
      },
    }
  }

  // ---- simulated live activity --------------------------------------------
  // Demonstrates the push path: an agent blocks on a permission a few seconds
  // in, and the roster/badge update without a manual refresh.

  private startLiveLoop() {
    if (this.liveTimer) return
    let tick = 0
    this.liveTimer = setInterval(() => {
      tick += 1
      if (tick === 2) {
        this.store.simulatePermission("TCK-412", "git push origin run/TCK-412")
        this.broadcastTicket("TCK-412")
        this.broadcastBoard("almadel-api")
        this.broadcastRoster()
      } else if (tick === 3) {
        // Alimiel's presence flickers its last_poll to stay fresh.
        const agent = this.store.agents.find((a) => a.id === "agt_alimiel")
        if (agent) {
          agent.last_poll = Date.now()
          this.broadcastRoster()
        }
      }
    }, 6_000)
  }

  private stopLiveLoop() {
    if (this.liveTimer) {
      clearInterval(this.liveTimer)
      this.liveTimer = null
    }
  }
}
