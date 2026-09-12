import { describe, expect, test } from "bun:test"
import { screen } from "@testing-library/react"
import { renderWithApp, makeState } from "./utils"
import { BoardPage } from "@/pages/BoardPage"

describe("BoardPage", () => {
  test("renders all three panes", () => {
    renderWithApp(<BoardPage />, makeState(), ["/p/almadel-api"])
    // Roster
    expect(screen.getAllByText("Alimiel").length).toBeGreaterThan(0)
    // Board
    expect(screen.getByText("Spec")).toBeInTheDocument()
    // Conversation empty state
    expect(screen.getByText("No conversation open")).toBeInTheDocument()
  })

  test("shows the header needs-you badge", () => {
    renderWithApp(<BoardPage />, makeState(), ["/p/almadel-api"])
    expect(screen.getByText("1 needs you")).toBeInTheDocument()
  })

  test("hides the roster when collapsed", () => {
    renderWithApp(<BoardPage />, makeState({ rosterCollapsed: true }), ["/p/almadel-api"])
    expect(screen.queryByText("Needs you")).toBeNull()
    expect(screen.getByText("Spec")).toBeInTheDocument()
    expect(screen.getByText("No conversation open")).toBeInTheDocument()
  })

  test("hides the chat panel when collapsed", () => {
    renderWithApp(<BoardPage />, makeState({ chatCollapsed: true }), ["/p/almadel-api"])
    expect(screen.getByText("Needs you")).toBeInTheDocument()
    expect(screen.getByText("Spec")).toBeInTheDocument()
    expect(screen.queryByText("No conversation open")).toBeNull()
  })

  test("shows both panes by default", () => {
    renderWithApp(<BoardPage />, makeState(), ["/p/almadel-api"])
    expect(screen.getByText("Needs you")).toBeInTheDocument()
    expect(screen.getByText("No conversation open")).toBeInTheDocument()
  })
})
