import { describe, expect, test } from "bun:test"
import { fireEvent, screen } from "@testing-library/react"
import { renderWithApp, makeState, project } from "./utils"
import { JoinPage } from "@/pages/JoinPage"
import type { Roster } from "@/types/domain"

function renderJoin(search = "?t=token123&project=almadel-api", roster?: Roster) {
  return renderWithApp(
    <JoinPage />,
    makeState({
      roster:
        roster ??
        {
          projects: [
            {
              project,
              agents: [],
            },
          ],
          needs_you: 0,
        },
    }),
    [`/join${search}`],
  )
}

describe("JoinPage", () => {
  test("shows a missing-token error without a token", () => {
    renderJoin("")
    expect(screen.getByText(/missing token/i)).toBeInTheDocument()
  })

  test("renders the two install steps", () => {
    renderJoin()
    expect(screen.getByText(/install the plugin/i)).toBeInTheDocument()
    expect(screen.getByText(/restart opencode, then join/i)).toBeInTheDocument()
    expect(screen.getByText(/bunx @almadel\/opencode-plugin init/)).toBeInTheDocument()
  })

  test("shows the token in the join command", () => {
    renderJoin()
    expect(screen.getByText(/--token token123/)).toBeInTheDocument()
  })

  test("shows pending until an agent joins", () => {
    renderJoin()
    expect(screen.getByText(/waiting for an agent to join/i)).toBeInTheDocument()
  })

  test("ticks green once an online slot appears", () => {
    const roster: Roster = {
      projects: [
        {
          project,
          agents: [
            {
              id: "a",
              project_id: project.id,
              name: "Gediel",
              label: null,
              repo_root: null,
              status: "idle",
              ticket_id: null,
              since: null,
              last_poll: Date.now(),
              opencode_version: null,
              registered_at: 1,
              online: true,
            },
          ],
        },
      ],
      needs_you: 0,
    }
    renderJoin("?t=token123&project=almadel-api", roster)
    expect(screen.getByText(/gediel joined/i)).toBeInTheDocument()
  })

  test("toggles the unattended worker section", () => {
    renderJoin()
    fireEvent.click(screen.getByText(/show unattended worker setup/i))
    expect(screen.getByText(/almadel-agent@\.service/)).toBeInTheDocument()
  })
})
