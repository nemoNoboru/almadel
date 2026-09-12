import type {
  AskInput,
  Board,
  ClaimBody,
  CommentInput,
  CreateTicketInput,
  EventBatch,
  Job,
  MoveTicketInput,
  PermissionRequestInput,
  PermissionRequestResult,
  Project,
  RegistrationInput,
  RegistrationResult,
  ReplyInput,
  TicketThread,
} from "./types.ts";

export class AlmadelError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Typed client for the Almadel server HTTP API.
 *
 * Holds the registration token in a closure. The token is never written to
 * disk or logged — it lives only in memory for the lifetime of the process.
 */
export class AlmadelClient {
  baseUrl: string;
  private token: string | null = null;
  private agentId: string | null = null;
  private fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  setAuth(token: string, agentId: string) {
    this.token = token;
    this.agentId = agentId;
  }

  /** Re-point the client at a different server (used by interactive join). */
  setServer(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      ...extra,
    };
    if (this.token) h["authorization"] = `Bearer ${this.token}`;
    if (this.agentId) h["x-almadel-agent"] = this.agentId;
    return h;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: this.headers(init.headers as Record<string, string>),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
    if (!res.ok) {
      const msg =
        (body as { error?: string } | undefined)?.error ??
        `HTTP ${res.status}`;
      throw new AlmadelError(msg, res.status);
    }
    return body as T;
  }

  listProjects(): Promise<Project[]> {
    return this.request<Project[]>("/api/projects");
  }

  getBoard(projectId: string): Promise<Board> {
    return this.request<Board>(`/api/projects/${projectId}/board`);
  }

  createTicket(
    projectId: string,
    input: Omit<CreateTicketInput, "project_id">,
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>("/api/tickets", {
      method: "POST",
      body: JSON.stringify({ ...input, project_id: projectId }),
    });
  }

  register(input: RegistrationInput): Promise<RegistrationResult> {
    return this.request<RegistrationResult>("/api/agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  deregister(agentId: string): Promise<void> {
    return this.request<void>(`/api/agents/${agentId}`, { method: "DELETE" });
  }

  claim(body: ClaimBody): Promise<Job | null> {
    return this.request<Job | null>("/api/claim", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  getTicket(ticketId: string): Promise<TicketThread> {
    return this.request<TicketThread>(`/api/tickets/${ticketId}`);
  }

  move(ticketId: string, input: MoveTicketInput): Promise<unknown> {
    return this.request(`/api/tickets/${ticketId}/move`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  reply(ticketId: string, input: ReplyInput): Promise<unknown> {
    return this.request(`/api/tickets/${ticketId}/reply`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  comment(ticketId: string, input: CommentInput): Promise<unknown> {
    return this.request(`/api/tickets/${ticketId}/comment`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  ask(ticketId: string, input: AskInput): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/api/tickets/${ticketId}/ask`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  pollQuestion(questionId: string): Promise<{ answer: string } | null> {
    return this.request<{ answer: string } | null>(
      `/api/questions/${questionId}`,
    );
  }

  requestPermission(
    ticketId: string,
    input: PermissionRequestInput,
  ): Promise<PermissionRequestResult> {
    return this.request<PermissionRequestResult>(
      `/api/tickets/${ticketId}/permission-request`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  pushEvents(ticketId: string, batch: EventBatch): Promise<unknown> {
    return this.request(`/api/tickets/${ticketId}/events`, {
      method: "POST",
      body: JSON.stringify(batch),
    });
  }

  sendMessage(agentId: string, input: { body: string }): Promise<unknown> {
    return this.request(`/api/agents/${agentId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}
