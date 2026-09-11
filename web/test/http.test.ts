import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { HttpClient } from "@/api/http"
import { ApiError } from "@/api/client"

type FetchFn = typeof fetch

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  private handlers = new Map<string, Array<(e: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (e: unknown) => void) {
    const list = this.handlers.get(type) ?? []
    list.push(fn)
    this.handlers.set(type, list)
  }

  emit(type: string) {
    for (const fn of this.handlers.get(type) ?? []) fn({ type })
  }

  close() {
    this.closed = true
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "x",
    json: async () => body,
  } as unknown as Response
}

describe("HttpClient", () => {
  const originalFetch = globalThis.fetch
  const originalES = (globalThis as { EventSource?: unknown }).EventSource

  beforeEach(() => {
    FakeEventSource.instances = []
    ;(globalThis as { EventSource: unknown }).EventSource = FakeEventSource
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    ;(globalThis as { EventSource?: unknown }).EventSource = originalES
  })

  test("getRoster parses JSON", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { needs_you: 2, projects: [] })) as FetchFn
    const client = new HttpClient()
    const roster = await client.getRoster()
    expect(roster.needs_you).toBe(2)
  })

  test("getBoard hits the board endpoint", async () => {
    let url = ""
    globalThis.fetch = (async (input: unknown) => {
      url = String(input)
      return jsonResponse(200, { project: {}, columns: [], tickets: [] })
    }) as FetchFn
    const client = new HttpClient()
    await client.getBoard("almadel-api")
    expect(url).toBe("/api/projects/almadel-api/board")
  })

  test("non-ok throws ApiError with message", async () => {
    globalThis.fetch = (async () => jsonResponse(404, { error: "ticket not found" })) as FetchFn
    const client = new HttpClient()
    await expect(client.getTicketThread("nope")).rejects.toThrow(ApiError)
  })

  test("non-ok surfaces zod issues", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(400, { issues: [{ path: "title", message: "required" }] })) as FetchFn
    const client = new HttpClient()
    try {
      await client.createTicket({ project_id: "p", title: "", body: "", column_id: "c" })
    } catch (e) {
      expect((e as ApiError).issues[0].message).toBe("required")
    }
  })

  test("204 is handled as undefined", async () => {
    globalThis.fetch = (async () => jsonResponse(204, null)) as FetchFn
    const client = new HttpClient()
    await expect(client.cancelTicket("TCK-1")).resolves.toBeUndefined()
  })

  test("mutations use POST bodies", async () => {
    let method = ""
    let body = ""
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      method = init?.method ?? "GET"
      body = String(init?.body)
      return jsonResponse(200, {})
    }) as FetchFn
    const client = new HttpClient()
    await client.reply("TCK-1", "hello")
    expect(method).toBe("POST")
    expect(body).toContain("hello")
  })

  test("updateComment uses PATCH on the comment endpoint", async () => {
    let method = ""
    let url = ""
    let body = ""
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      url = String(input)
      method = init?.method ?? "GET"
      body = String(init?.body)
      return jsonResponse(204, null)
    }) as FetchFn
    const client = new HttpClient()
    await client.updateComment("TCK-1", 42, "fixed")
    expect(method).toBe("PATCH")
    expect(url).toBe("/api/tickets/TCK-1/comments/42")
    expect(body).toContain("fixed")
  })

  test("draftTicket posts and returns the draft", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, { title: "T", body: "B", agent_name: "Alimiel" })) as FetchFn
    const client = new HttpClient()
    const draft = await client.draftTicket({
      project_id: "p",
      agent_id: "a",
      instruction: "do it",
    })
    expect(draft.agent_name).toBe("Alimiel")
  })

  test("subscribe opens a roster stream and closes on unsubscribe", () => {
    const client = new HttpClient()
    const handle = client.subscribe(() => {})
    expect(FakeEventSource.instances[0].url).toBe("/api/roster/stream")
    handle.unsubscribe()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  test("subscribe emits roster events", () => {
    const client = new HttpClient()
    const seen: string[] = []
    client.subscribe((e) => seen.push(e.type))
    FakeEventSource.instances[0].emit("roster")
    expect(seen).toEqual(["roster"])
  })

  test("subscribeTicket uses the ticket stream url", () => {
    const client = new HttpClient()
    client.subscribeTicket("TCK-9", () => {})
    expect(FakeEventSource.instances[0].url).toBe("/api/tickets/TCK-9/stream")
  })
})
