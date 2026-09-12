import { describe, expect, test, vi } from "bun:test"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { renderWithApp, makeState, makeThread } from "./utils"
import { ConversationPanel } from "@/components/conversation/ConversationPanel"
import type { Roster as RosterType } from "@/types/domain"
import { makeAgent, project } from "./utils"

describe("ConversationPanel — no selection", () => {
  test("shows an empty state", () => {
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: null }))
    expect(screen.getByText("No conversation open")).toBeInTheDocument()
  })
})

describe("ConversationPanel — thread", () => {
  test("renders the ticket header", () => {
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread() }),
    )
    expect(screen.getByText("TCK-3")).toBeInTheDocument()
    expect(screen.getByText("needs answer")).toBeInTheDocument()
  })

  test("renders a question comment with a label", () => {
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread() }),
    )
    expect(screen.getByText("Which backend?")).toBeInTheDocument()
    expect(screen.getByText("question")).toBeInTheDocument()
  })

  test("renders a plan comment with a plan label", () => {
    const thread = makeThread({
      ticket: makeThread().ticket,
      comments: [{ id: 1, ticket_id: "TCK-3", author: "agent", kind: "plan", body: "# Plan", created_at: 1, updated_at: null }],
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.getByText("plan")).toBeInTheDocument()
  })

  test("renders agent markdown comment bodies as formatted content", () => {
    const thread = makeThread({
      ticket: makeThread().ticket,
      comments: [
        {
          id: 1,
          ticket_id: "TCK-3",
          author: "agent",
          kind: "comment",
          body: "## Steps\n\n- one\n- two",
          created_at: 1,
          updated_at: null,
        },
      ],
    })
    const { container } = renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread }),
    )
    expect(container.querySelector("h2")).toHaveTextContent("Steps")
    expect(container.querySelector("ul")?.querySelectorAll("li")).toHaveLength(2)
    expect(container.textContent).not.toContain("##")
  })

  test("close button clears the conversation", () => {
    const closeConversation = vi.fn()
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread(), closeConversation }),
    )
    fireEvent.click(screen.getByRole("button", { name: /close conversation/i }))
    expect(closeConversation).toHaveBeenCalled()
  })
})

describe("ConversationPanel — compose by state", () => {
  test("blocked_question shows a reply box", () => {
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread() }),
    )
    expect(screen.getByPlaceholderText(/answer the agent/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /reply/i })).toBeInTheDocument()
  })

  test("blocked_permission shows allow/deny and no text box", () => {
    const thread = makeThread({
      ticket: { ...makeThread().ticket, state: "blocked_permission" },
      permission: { id: "p-1", ticket_id: "TCK-3", tool: "bash", command: "git push", decision: null, scope: null, created_at: 1, decided_at: null },
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.getByText("git push")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /allow/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  test("working shows a queue control", () => {
    const thread = makeThread({
      ticket: { ...makeThread().ticket, state: "running" },
      question: null,
      comments: [],
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.getByRole("button", { name: /queue/i })).toBeInTheDocument()
  })

  test("done shows a comment box", () => {
    const thread = makeThread({
      ticket: { ...makeThread().ticket, state: "done", agent_id: null },
      question: null,
      comments: [],
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /comment/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /take over/i })).toBeNull()
  })

  test("ready shows a comment box", () => {
    const thread = makeThread({
      ticket: { ...makeThread().ticket, state: "ready", agent_id: null },
      question: null,
      comments: [],
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /comment/i })).toBeInTheDocument()
  })

  test("failed shows a comment box", () => {
    const thread = makeThread({
      ticket: { ...makeThread().ticket, state: "failed", agent_id: null },
      question: null,
      comments: [],
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /comment/i })).toBeInTheDocument()
  })

  test("offline agent still shows a comment box", () => {
    const offlineRoster: RosterType = {
      projects: [{ project, agents: [makeAgent({ id: "agt-off", name: "Ghost", online: false })] }],
      needs_you: 0,
    }
    const thread = makeThread({
      ticket: { ...makeThread().ticket, state: "blocked_question", agent_id: "agt-off" },
    })
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread, roster: offlineRoster }),
    )
    expect(screen.getByText(/won't respond until it reconnects/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/add a comment/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^comment$/i })).toBeInTheDocument()
  })
})

describe("ConversationPanel — actions", () => {
  test("shows cancel and takeover for a live ticket", () => {
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread() }),
    )
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /take over/i })).toBeInTheDocument()
  })

  test("cancel opens a confirmation dialog", () => {
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread() }),
    )
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(screen.getByText(/cancel the run/i)).toBeInTheDocument()
  })

  test("take over opens a confirmation dialog", () => {
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread() }),
    )
    fireEvent.click(screen.getByRole("button", { name: /take over/i }))
    expect(screen.getByText(/take over the ticket/i)).toBeInTheDocument()
  })

  test("replying posts and clears the box", async () => {
    const reply = vi.fn()
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread(), reply }),
    )
    fireEvent.change(screen.getByPlaceholderText(/answer the agent/i), {
      target: { value: "Use JWT" },
    })
    fireEvent.click(screen.getByRole("button", { name: /reply/i }))
    await waitFor(() => expect(reply).toHaveBeenCalledWith("TCK-3", "Use JWT"))
  })

  test("commenting on a done ticket posts via reply", async () => {
    const reply = vi.fn()
    const thread = makeThread({
      ticket: { ...makeThread().ticket, state: "done", agent_id: null },
      question: null,
      comments: [],
    })
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread, reply }),
    )
    fireEvent.change(screen.getByPlaceholderText(/add a comment/i), {
      target: { value: "Looks good" },
    })
    fireEvent.click(screen.getByRole("button", { name: /comment/i }))
    await waitFor(() => expect(reply).toHaveBeenCalledWith("TCK-3", "Looks good"))
  })
})

describe("ConversationPanel — permissions and actions", () => {
  const permissionThread = () =>
    makeThread({
      ticket: { ...makeThread().ticket, state: "blocked_permission" },
      question: null,
      comments: [],
      permission: {
        id: "p-1",
        ticket_id: "TCK-3",
        tool: "bash",
        command: "git push",
        decision: null,
        scope: null,
        created_at: 1,
        decided_at: null,
      },
    })

  test("allowing a permission uses the selected scope", async () => {
    const decidePermission = vi.fn()
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: permissionThread(), decidePermission }),
    )
    fireEvent.click(screen.getByText("always"))
    fireEvent.click(screen.getByRole("button", { name: /allow/i }))
    await waitFor(() =>
      expect(decidePermission).toHaveBeenCalledWith("TCK-3", "allow", "always"),
    )
  })

  test("denying a permission posts deny", async () => {
    const decidePermission = vi.fn()
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: permissionThread(), decidePermission }),
    )
    fireEvent.click(screen.getByRole("button", { name: /deny/i }))
    await waitFor(() =>
      expect(decidePermission).toHaveBeenCalledWith("TCK-3", "deny", "once"),
    )
  })

  test("confirming cancel calls cancel", async () => {
    const cancel = vi.fn()
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread(), cancel }),
    )
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }))
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("TCK-3"))
  })

  test("confirming takeover calls takeover", async () => {
    const takeover = vi.fn()
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread(), takeover }),
    )
    fireEvent.click(screen.getByRole("button", { name: /take over/i }))
    fireEvent.click(screen.getByRole("button", { name: /^take over$/i }))
    await waitFor(() => expect(takeover).toHaveBeenCalledWith("TCK-3"))
  })

  test("nudging a working ticket queues via reply", async () => {
    const reply = vi.fn()
    const thread = makeThread({
      ticket: { ...makeThread().ticket, state: "running" },
      question: null,
      comments: [],
    })
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread, reply }),
    )
    fireEvent.change(screen.getByPlaceholderText(/message the agent/i), {
      target: { value: "keep going" },
    })
    fireEvent.click(screen.getByRole("button", { name: /queue/i }))
    await waitFor(() => expect(reply).toHaveBeenCalledWith("TCK-3", "keep going"))
  })

  test("renders a system move comment centered", () => {
    const thread = makeThread({
      ticket: makeThread().ticket,
      question: null,
      comments: [
        { id: 1, ticket_id: "TCK-3", author: "system", kind: "move", body: "moved to Done", created_at: 1, updated_at: null },
      ],
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.getByText("moved to Done")).toBeInTheDocument()
  })
})

describe("ConversationPanel — comment editing", () => {
  const planComment = {
    id: 7,
    ticket_id: "TCK-3",
    author: "agent" as const,
    kind: "plan" as const,
    body: "# Plan",
    created_at: 1,
    updated_at: null as number | null,
  }

  test("editing reveals a textarea and saves via updateComment", async () => {
    const updateComment = vi.fn()
    const thread = makeThread({ comments: [planComment] })
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread, updateComment }),
    )
    fireEvent.click(screen.getByRole("button", { name: /edit comment/i }))
    fireEvent.change(screen.getByDisplayValue("# Plan"), { target: { value: "fixed plan" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => expect(updateComment).toHaveBeenCalledWith("TCK-3", 7, "fixed plan"))
  })

  test("renders an edited marker when updated_at is set", () => {
    const thread = makeThread({
      comments: [{ ...planComment, updated_at: 2 }],
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.getByText(/edited/i)).toBeInTheDocument()
  })

  test("system comments have no edit affordance", () => {
    const thread = makeThread({
      comments: [
        { id: 8, ticket_id: "TCK-3", author: "system", kind: "move", body: "moved", created_at: 1, updated_at: null },
      ],
    })
    renderWithApp(<ConversationPanel />, makeState({ selectedTicketId: "TCK-3", thread }))
    expect(screen.queryByRole("button", { name: /edit comment/i })).toBeNull()
  })
})

describe("ConversationPanel — resizable width", () => {
  test("renders the panel at the persisted width with a drag handle", () => {
    const { container } = renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread(), chatWidth: 480 }),
    )
    expect(container.querySelector("aside")?.style.width).toBe("480px")
    expect(container.querySelector('[class*="cursor-col-resize"]')).not.toBeNull()
  })

  test("dragging the left handle resizes the panel", () => {
    const setChatWidth = vi.fn()
    const { container } = renderWithApp(
      <ConversationPanel />,
      makeState({
        selectedTicketId: "TCK-3",
        thread: makeThread(),
        chatWidth: 384,
        setChatWidth,
      }),
    )
    const handle = container.querySelector('[class*="cursor-col-resize"]') as HTMLElement
    fireEvent.pointerDown(handle, { clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 400 })
    fireEvent.pointerUp(window)
    expect(setChatWidth).toHaveBeenCalledWith(484)
  })
})

describe("ConversationPanel — wider view modal", () => {
  test("opens a modal that mirrors the thread and closes again", () => {
    renderWithApp(
      <ConversationPanel />,
      makeState({ selectedTicketId: "TCK-3", thread: makeThread() }),
    )
    const expand = screen.getByRole("button", { name: /open in wider view/i })
    expect(expand).toBeInTheDocument()

    fireEvent.click(expand)
    const dialog = screen.getByRole("dialog")
    expect(dialog).toBeInTheDocument()
    expect(screen.getAllByText("Which backend?")).toHaveLength(2)

    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
