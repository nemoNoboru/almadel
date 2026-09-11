import { describe, expect, test, vi } from "bun:test"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { renderWithApp, makeState, columns, makeAgent, project } from "./utils"
import { NewTicketDialog } from "@/components/board/NewTicketDialog"
import type { Roster } from "@/types/domain"

function idleRoster(): Roster {
  return {
    projects: [
      {
        project,
        agents: [
          makeAgent({ id: "agt_barachiel", name: "Barachiel", status: "idle", online: true }),
        ],
      },
    ],
    needs_you: 0,
  }
}

function renderDialog(state = makeState({ roster: idleRoster() })) {
  const onOpenChange = vi.fn()
  const utils = renderWithApp(
    <NewTicketDialog open column={columns[0]} onOpenChange={onOpenChange} />,
    state,
  )
  return { ...utils, onOpenChange }
}

describe("NewTicketDialog — write mode", () => {
  test("renders title and body fields", () => {
    renderDialog()
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/body/i)).toBeInTheDocument()
  })

  test("creates a ticket on submit", async () => {
    const createTicket = vi.fn()
    renderDialog(makeState({ roster: idleRoster(), createTicket }))
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "New thing" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() =>
      expect(createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ title: "New thing", column_id: "col-spec" }),
      ),
    )
  })
})

describe("NewTicketDialog — draft mode", () => {
  test("toggles to the draft controls", () => {
    renderDialog()
    fireEvent.click(screen.getByText("Ask an agent to draft"))
    expect(screen.getByLabelText(/agent \(idle slot\)/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/what should the card be about/i)).toBeInTheDocument()
  })

  test("shows a note when no idle agents", () => {
    renderDialog(makeState({ roster: { projects: [{ project, agents: [] }], needs_you: 0 } }))
    fireEvent.click(screen.getByText("Ask an agent to draft"))
    expect(screen.getByText(/no idle agents/i)).toBeInTheDocument()
  })

  test("drafts the card into the fields", async () => {
    renderDialog()
    fireEvent.click(screen.getByText("Ask an agent to draft"))

    fireEvent.click(screen.getByLabelText(/agent \(idle slot\)/i))
    fireEvent.click(screen.getByText("Barachiel"))

    fireEvent.change(screen.getByLabelText(/what should the card be about/i), {
      target: { value: "add a cache for the roster" },
    })
    fireEvent.click(screen.getByRole("button", { name: /draft card/i }))

    await waitFor(
      () => {
        expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe(
          "add a cache for the roster",
        )
      },
      { timeout: 4000 },
    )
    expect(screen.getByText(/drafted by barachiel/i)).toBeInTheDocument()
  })
})
