import type { AlmadelClient, Message, StreamEvent, SubscribeHandle, TicketDraft } from "./client"
import { ApiError } from "./client"
import type { Board, Roster, TicketThread } from "@/types/domain"

// Real HTTP client targeting the browser-facing API (plan/03-api-surface.md).
// The server is a single process serving JSON + SSE from the same origin, so
// relative paths work both in dev (Vite proxy) and when served by almadel.

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  })

  if (!res.ok) {
    let issues: Array<{ path: string; message: string }> = []
    let message = res.statusText || "request failed"
    try {
      const body = await res.json()
      if (typeof body === "string") message = body
      else if (body?.error) message = body.error
      if (Array.isArray(body?.issues)) issues = body.issues
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message, issues)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export class HttpClient implements AlmadelClient {
  async getRoster() {
    return request<Roster>("/api/roster")
  }

  async getBoard(projectId: string) {
    return request<Board>(`/api/projects/${projectId}/board`)
  }

  async getTicketThread(ticketId: string) {
    return request<TicketThread>(`/api/tickets/${ticketId}`)
  }

  async listProjects() {
    return request<{ id: string; name: string }[]>("/api/projects")
  }

  async listMessages(agentId: string) {
    return request<Message[]>(`/api/agents/${agentId}/messages`)
  }

  async sendMessage(agentId: string, body: string) {
    await request(`/api/agents/${agentId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    })
  }

  async createTicket(input: {
    project_id: string
    title: string
    body: string
    column_id: string
  }) {
    await request("/api/tickets", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  async draftTicket(input: {
    project_id: string
    agent_id: string
    instruction: string
  }) {
    return request<TicketDraft>("/api/tickets/draft", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  async moveTicket(ticketId: string, input: { column: string; note?: string }) {
    await request(`/api/tickets/${ticketId}/move`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  async reply(ticketId: string, body: string) {
    await request(`/api/tickets/${ticketId}/reply`, {
      method: "POST",
      body: JSON.stringify({ body }),
    })
  }

  async updateComment(ticketId: string, commentId: number, body: string) {
    await request(`/api/tickets/${ticketId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    })
  }

  async decidePermission(
    ticketId: string,
    decision: "allow" | "deny",
    scope: "once" | "always" | "session",
  ) {
    await request(`/api/tickets/${ticketId}/permission`, {
      method: "POST",
      body: JSON.stringify({ decision, scope }),
    })
  }

  async cancelTicket(ticketId: string) {
    await request(`/api/tickets/${ticketId}/cancel`, { method: "POST" })
  }

  async takeoverTicket(ticketId: string) {
    await request(`/api/tickets/${ticketId}/takeover`, { method: "POST" })
  }

  async updateColumns(
    projectId: string,
    columns: Array<Partial<{ id: string; name: string; prompt: string | null; model: string | null; next_column: string | null; fail_column: string | null; wip_limit: number | null }>>,
  ) {
    await request(`/api/projects/${projectId}/columns`, {
      method: "PUT",
      body: JSON.stringify({ columns }),
    })
  }

  subscribe(onEvent: (e: StreamEvent) => void): SubscribeHandle {
    return this.openRosterStream(onEvent)
  }

  subscribeTicket(
    ticketId: string,
    onEvent: (e: StreamEvent) => void,
  ): SubscribeHandle {
    return this.openTicketStream(ticketId, onEvent)
  }

  // SSE wiring (plan/03-api-surface.md, plan/frontend/07-events-and-live-log.md):
  // the stream only says "something changed"; the client re-fetches the query.
  private openRosterStream(onEvent: (e: StreamEvent) => void): SubscribeHandle {
    const es = new EventSource("/api/roster/stream")
    es.addEventListener("roster", () => onEvent({ type: "roster" }))
    return {
      unsubscribe: () => es.close(),
    }
  }

  private openTicketStream(
    ticketId: string,
    onEvent: (e: StreamEvent) => void,
  ): SubscribeHandle {
    const es = new EventSource(`/api/tickets/${ticketId}/stream`)
    es.addEventListener("tick", () => onEvent({ type: "ticket", ticket_id: ticketId }))
    return {
      unsubscribe: () => es.close(),
    }
  }
}
