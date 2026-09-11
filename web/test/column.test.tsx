import { describe, expect, test, vi } from "bun:test"
import { fireEvent, screen } from "@testing-library/react"
import { renderWithApp, columns, tickets, makeTicket } from "./utils"
import { Column } from "@/components/board/Column"

const agentNames = new Map<string, string>([["agt-1", "Alimiel"]])

function renderColumn(overrides: Record<string, unknown> = {}) {
  const onSelect = vi.fn()
  const onDragStart = vi.fn()
  const onDragEnd = vi.fn()
  const onDrop = vi.fn()
  const onEdit = vi.fn()
  const onNewTicket = vi.fn()
  const utils = renderWithApp(
    <Column
      column={columns[0]}
      tickets={[]}
      agentNames={agentNames}
      selectedTicketId={null}
      draggingTicketId={null}
      onSelect={onSelect}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      onEdit={onEdit}
      onNewTicket={onNewTicket}
      {...overrides}
    />,
  )
  return { ...utils, onSelect, onDrop, onEdit, onNewTicket }
}

describe("Column", () => {
  test("shows the column name", () => {
    renderColumn()
    expect(screen.getByText("Spec")).toBeInTheDocument()
  })

  test("gate column shows manual, prompted shows auto", () => {
    renderColumn()
    expect(screen.getByText("manual")).toBeInTheDocument()

    renderColumn({ column: columns[1] })
    expect(screen.getByText("auto")).toBeInTheDocument()
  })

  test("shows WIP usage and FULL at the limit", () => {
    renderColumn({
      column: columns[1],
      tickets: [
        makeTicket({ id: "a", column_id: "col-planning", state: "running" }),
        makeTicket({ id: "b", column_id: "col-planning", state: "blocked_question" }),
      ],
    })
    expect(screen.getByText("2/2 FULL")).toBeInTheDocument()
  })

  test("edit button fires onEdit", () => {
    const { onEdit } = renderColumn()
    fireEvent.click(screen.getByRole("button", { name: /edit spec/i }))
    expect(onEdit).toHaveBeenCalledWith(columns[0])
  })

  test("new card button fires onNewTicket", () => {
    const { onNewTicket } = renderColumn()
    fireEvent.click(screen.getByText("New card"))
    expect(onNewTicket).toHaveBeenCalledWith(columns[0])
  })

  test("dropping a card calls onDrop with the ticket id", () => {
    const { onDrop } = renderColumn()
    fireEvent.drop(screen.getByTestId(`column-drop-${columns[0].id}`), {
      dataTransfer: { getData: () => "TCK-5" },
    })
    expect(onDrop).toHaveBeenCalledWith("TCK-5", columns[0].id)
  })

  test("renders its tickets", () => {
    renderColumn({ tickets: [tickets[0]] })
    expect(screen.getByText("Spec ticket")).toBeInTheDocument()
  })
})
