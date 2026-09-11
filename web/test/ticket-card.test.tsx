import { describe, expect, test, vi } from "bun:test"
import { fireEvent, screen } from "@testing-library/react"
import { renderWithApp, makeTicket } from "./utils"
import { TicketCard } from "@/components/board/TicketCard"

function renderCard(ticket = makeTicket(), agentName?: string) {
  const onSelect = vi.fn()
  const onDragStart = vi.fn()
  const onDragEnd = vi.fn()
  const utils = renderWithApp(
    <TicketCard
      ticket={ticket}
      agentName={agentName}
      selected={false}
      onSelect={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    />,
  )
  return { ...utils, onSelect, onDragStart, onDragEnd }
}

describe("TicketCard", () => {
  test("renders id and title", () => {
    renderCard(makeTicket({ id: "TCK-9", title: "Fix the thing" }))
    expect(screen.getByText("TCK-9")).toBeInTheDocument()
    expect(screen.getByText("Fix the thing")).toBeInTheDocument()
  })

  test.each([
    ["ready", "ready"],
    ["running", "running"],
    ["blocked_question", "needs answer"],
    ["blocked_permission", "needs decision"],
    ["done", "done"],
    ["failed", "failed"],
  ] as const)("shows %s chip as %s", (state, label) => {
    renderCard(makeTicket({ state }))
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  test("renders agent name and branch", () => {
    renderCard(
      makeTicket({ agent_id: "agt-1", branch: "run/TCK-1" }),
      "Alimiel",
    )
    expect(screen.getByText("Alimiel")).toBeInTheDocument()
    expect(screen.getByText("run/TCK-1")).toBeInTheDocument()
  })

  test("clicking selects the ticket", () => {
    const { onSelect } = renderCard()
    fireEvent.click(screen.getByText("A ticket"))
    expect(onSelect).toHaveBeenCalled()
  })

  test("enter key selects the ticket", () => {
    const { onSelect } = renderCard()
    fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" })
    expect(onSelect).toHaveBeenCalled()
  })
})
