import { describe, expect, test, vi } from "bun:test"
import { fireEvent, screen } from "@testing-library/react"
import { renderWithApp, makeState, roster, makeAgent, project } from "./utils"
import { Roster } from "@/components/roster/Roster"
import type { Roster as RosterType } from "@/types/domain"

describe("Roster", () => {
  test("groups agents under the project name", () => {
    renderWithApp(<Roster />)
    expect(screen.getByText("almadel-api")).toBeInTheDocument()
    expect(screen.getByText("Alimiel")).toBeInTheDocument()
    expect(screen.getByText("Gediel")).toBeInTheDocument()
  })

  test("shows status labels", () => {
    renderWithApp(<Roster />)
    expect(screen.getByText("working")).toBeInTheDocument()
    expect(screen.getAllByText("blocked").length).toBeGreaterThan(0)
    expect(screen.getByText("idle")).toBeInTheDocument()
  })

  test("shows offline for an offline agent", () => {
    const offlineRoster: RosterType = {
      projects: [
        { project, agents: [makeAgent({ id: "x", name: "Ghost", online: false, last_poll: 1 })] },
      ],
      needs_you: 0,
    }
    renderWithApp(<Roster />, makeState({ roster: offlineRoster }))
    expect(screen.getAllByText("offline").length).toBeGreaterThan(0)
  })

  test("shows the needs-you badge from the roster", () => {
    renderWithApp(<Roster />, makeState({ roster }))
    expect(screen.getByText("Needs you")).toBeInTheDocument()
    expect(screen.getByText("1")).toBeInTheDocument()
  })

  test("shows empty state when a project has no agents", () => {
    const empty: RosterType = { projects: [{ project, agents: [] }], needs_you: 0 }
    renderWithApp(<Roster />, makeState({ roster: empty }))
    expect(screen.getByText("no agents joined")).toBeInTheDocument()
  })

  test("clicking an agent opens its chat", () => {
    const selectAgent = vi.fn()
    renderWithApp(<Roster />, makeState({ selectAgent }))
    fireEvent.click(screen.getByText("Gediel"))
    expect(selectAgent).toHaveBeenCalledWith("agt-2")
  })

  test("clicking a project selects it", () => {
    const selectProject = vi.fn()
    renderWithApp(<Roster />, makeState({ selectProject }))
    fireEvent.click(screen.getByText("almadel-api"))
    expect(selectProject).toHaveBeenCalledWith("almadel-api")
  })
})
