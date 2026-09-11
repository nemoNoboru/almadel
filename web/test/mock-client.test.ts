import { describe, expect, test } from "bun:test"
import { MockClient } from "@/api/mock/client"
import { ApiError } from "@/api/client"

describe("MockClient queries", () => {
  test("getRoster returns needs_you and projects", async () => {
    const client = new MockClient()
    const roster = await client.getRoster()
    expect(roster.needs_you).toBe(1)
    expect(roster.projects.length).toBeGreaterThan(0)
  })

  test("getBoard returns the project's columns and tickets", async () => {
    const client = new MockClient()
    const board = await client.getBoard("almadel-api")
    expect(board.project.id).toBe("almadel-api")
    expect(board.columns.length).toBe(7)
  })

  test("getTicketThread returns the thread", async () => {
    const client = new MockClient()
    const thread = await client.getTicketThread("TCK-418")
    expect(thread.ticket.id).toBe("TCK-418")
  })

  test("getTicketThread throws 404 for unknown ticket", async () => {
    const client = new MockClient()
    await expect(client.getTicketThread("nope")).rejects.toThrow(ApiError)
    try {
      await client.getTicketThread("nope")
    } catch (e) {
      expect((e as ApiError).status).toBe(404)
    }
  })

  test("listProjects returns ids and names", async () => {
    const client = new MockClient()
    const projects = await client.listProjects()
    expect(projects.map((p) => p.id)).toContain("almadel-api")
  })
})

describe("MockClient mutations", () => {
  test("createTicket then getBoard shows it", async () => {
    const client = new MockClient()
    await client.createTicket({
      project_id: "almadel-api",
      title: "Brand new",
      body: "",
      column_id: "col-spec",
    })
    const board = await client.getBoard("almadel-api")
    expect(board.tickets.some((t) => t.title === "Brand new")).toBe(true)
  })

  test("moveTicket across projects throws ApiError", async () => {
    const client = new MockClient()
    await expect(
      client.moveTicket("TCK-405", { column: "web-col-build" }),
    ).rejects.toThrow(ApiError)
  })

  test("reply answers a blocked ticket", async () => {
    const client = new MockClient()
    await client.reply("TCK-418", "Use JWT")
    const thread = await client.getTicketThread("TCK-418")
    expect(thread.ticket.state).toBe("running")
  })

  test("updateComment edits a non-system comment", async () => {
    const client = new MockClient()
    await client.updateComment("TCK-412", 2, "revised plan")
    const thread = await client.getTicketThread("TCK-412")
    const comment = thread.comments.find((c) => c.id === 2)
    expect(comment?.body).toBe("revised plan")
    expect(comment?.updated_at).toBeGreaterThan(0)
  })

  test("updateComment rejects system comments", async () => {
    const client = new MockClient()
    await expect(client.updateComment("TCK-412", 1, "nope")).rejects.toThrow(
      "system comments are not editable",
    )
  })

  test("decidePermission / cancel / takeover resolve", async () => {
    const client = new MockClient()
    await expect(client.cancelTicket("TCK-412")).resolves.toBeUndefined()
    await expect(client.takeoverTicket("TCK-412")).resolves.toBeUndefined()
    await expect(
      client.decidePermission("TCK-412", "allow", "once"),
    ).resolves.toBeUndefined()
  })

  test("updateColumns persists", async () => {
    const client = new MockClient()
    await client.updateColumns("almadel-web", [
      { id: "x", name: "Only" },
    ] as never[])
    const board = await client.getBoard("almadel-web")
    expect(board.columns.map((c) => c.name)).toEqual(["Only"])
  })
})

describe("MockClient.draftTicket", () => {
  test("returns a title and structured body", async () => {
    const client = new MockClient()
    const draft = await client.draftTicket({
      project_id: "almadel-api",
      agent_id: "agt_barachiel",
      instruction: "add rate limiting to /auth",
    })
    expect(draft.title).toBe("add rate limiting to /auth")
    expect(draft.body).toContain("## Context")
    expect(draft.agent_name).toBe("Barachiel")
  })
})

describe("MockClient subscribe", () => {
  test("returns a handle that unsubscribes", async () => {
    const client = new MockClient()
    const events: string[] = []
    const handle = client.subscribe((e) => events.push(e.type))
    handle.unsubscribe()
    const ticketHandle = client.subscribeTicket("TCK-1", (e) => events.push(e.type))
    ticketHandle.unsubscribe()
    expect(events).toEqual([])
  })
})
