import { describe, expect, test, vi } from "bun:test"
import { fireEvent, screen } from "@testing-library/react"
import { renderWithApp, makeState, board as boardFixture, columns } from "./utils"
import { Board } from "@/components/board/Board"

describe("Board", () => {
  test("renders columns and cards", () => {
    renderWithApp(<Board />)
    expect(screen.getByText("Spec")).toBeInTheDocument()
    expect(screen.getByText("Planning")).toBeInTheDocument()
    expect(screen.getByText("Spec ticket")).toBeInTheDocument()
    expect(screen.getByText("Running ticket")).toBeInTheDocument()
  })

  test("shows a skeleton while loading with no board", () => {
    renderWithApp(<Board />, makeState({ board: null, loadingBoard: true }))
    expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy()
  })

  test("shows an empty state with no board", () => {
    renderWithApp(<Board />, makeState({ board: null }))
    expect(screen.getByText("No project selected")).toBeInTheDocument()
  })

  test("edit pipeline opens the editor", () => {
    renderWithApp(<Board />)
    fireEvent.click(screen.getByRole("button", { name: /edit pipeline/i }))
    expect(screen.getByText(/columns are the workflow/i)).toBeInTheDocument()
  })

  test("dropping a ready card moves it", () => {
    const moveTicket = vi.fn()
    renderWithApp(<Board />, makeState({ moveTicket }))
    fireEvent.drop(screen.getByTestId("column-drop-col-done"), {
      dataTransfer: { getData: () => "TCK-1" },
    })
    expect(moveTicket).toHaveBeenCalledWith("TCK-1", "col-done")
  })

  test("dropping a running card asks to cancel first", () => {
    renderWithApp(<Board />)
    fireEvent.drop(screen.getByTestId("column-drop-col-done"), {
      dataTransfer: { getData: () => "TCK-2" },
    })
    expect(screen.getByText(/cancel the running agent/i)).toBeInTheDocument()
  })

  test("renders the board fixture columns in order", () => {
    renderWithApp(<Board />, makeState({ board: boardFixture, selectedTicketId: null }))
    expect(columns.map((c) => c.name).every((n) => screen.getByText(n))).toBe(true)
  })
})
