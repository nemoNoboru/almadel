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
})
