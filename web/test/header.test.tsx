import { describe, expect, test } from "bun:test"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { renderWithApp, makeState } from "./utils"
import { Header } from "@/components/layout/Header"

describe("Header", () => {
  test("shows the brand and project switcher", () => {
    renderWithApp(<Header />)
    expect(screen.getByText("Almadel")).toBeInTheDocument()
    expect(screen.getByText("almadel-api")).toBeInTheDocument()
  })

  test("shows the needs-you badge when blocked tickets exist", () => {
    renderWithApp(<Header />)
    expect(screen.getByText("1 needs you")).toBeInTheDocument()
  })

  test("hides the badge when nothing needs you", () => {
    renderWithApp(
      <Header />,
      makeState({
        roster: { projects: [], needs_you: 0 },
      }),
    )
    expect(screen.queryByText(/needs you/)).toBeNull()
  })

  test("renders the theme toggle button", () => {
    renderWithApp(<Header />)
    expect(screen.getByRole("button", { name: /toggle theme/i })).toBeInTheDocument()
  })

  test("clicking the theme toggle flips the theme", async () => {
    renderWithApp(<Header />)
    fireEvent.click(screen.getByRole("button", { name: /toggle theme/i }))
    await waitFor(() =>
      expect(document.documentElement.classList.contains("light")).toBe(true),
    )
  })
})
