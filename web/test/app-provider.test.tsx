import { describe, expect, test } from "bun:test"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AppProvider, useApp } from "@/state/AppProvider"

function Probe() {
  const app = useApp()
  const board = app.board
  return (
    <div>
      <span data-testid="loading">{app.board ? "loaded" : "loading"}</span>
      <span data-testid="project">{app.selectedProjectId ?? "none"}</span>
      <span data-testid="columns">{board?.columns.map((c) => c.name).join(",") ?? ""}</span>
      <span data-testid="titles">{board?.tickets.map((t) => t.title).join(",") ?? ""}</span>
      <span data-testid="thread">{app.thread?.ticket.id ?? "none"}</span>
      <span data-testid="tck405">{board?.tickets.find((t) => t.id === "TCK-405")?.column_id ?? ""}</span>
      <span data-testid="tck418state">{board?.tickets.find((t) => t.id === "TCK-418")?.state ?? ""}</span>
      <span data-testid="needsYou">{app.roster?.needs_you ?? -1}</span>
      <button onClick={() => app.selectTicket("TCK-412")}>select-ticket</button>
      <button onClick={() => app.moveTicket("TCK-405", "col-done")}>move</button>
      <button onClick={() => app.createTicket({ project_id: "almadel-api", title: "Integration", body: "", column_id: "col-spec" })}>
        create
      </button>
      <button onClick={() => app.reply("TCK-418", "Use JWT")}>reply</button>
      <button onClick={() => app.closeConversation()}>close</button>
      <button onClick={() => app.selectProject("almadel-web")}>switch-project</button>
    </div>
  )
}

function renderApp() {
  return render(
    <AppProvider>
      <Probe />
    </AppProvider>,
  )
}

describe("AppProvider integration", () => {
  test("loads projects, roster and board on mount", async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("loaded"))
    expect(screen.getByTestId("project").textContent).toBe("almadel-api")
    expect(screen.getByTestId("columns").textContent).toContain("Spec")
    expect(screen.getByTestId("needsYou").textContent).toBe("1")
  })

  test("selecting a ticket loads its thread", async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("loaded"))
    fireEvent.click(screen.getByText("select-ticket"))
    await waitFor(() => expect(screen.getByTestId("thread").textContent).toBe("TCK-412"))
  })

  test("moving a ticket updates its column", async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("loaded"))
    fireEvent.click(screen.getByText("move"))
    await waitFor(() => expect(screen.getByTestId("tck405").textContent).toBe("col-done"))
  })

  test("creating a ticket appears on the board", async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("loaded"))
    fireEvent.click(screen.getByText("create"))
    await waitFor(() =>
      expect(screen.getByTestId("titles").textContent).toContain("Integration"),
    )
  })

  test("replying resolves a blocked ticket to running", async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("loaded"))
    fireEvent.click(screen.getByText("reply"))
    await waitFor(() => expect(screen.getByTestId("tck418state").textContent).toBe("running"))
  })

  test("switching projects reloads the board", async () => {
    renderApp()
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("loaded"))
    fireEvent.click(screen.getByText("switch-project"))
    await waitFor(() => expect(screen.getByTestId("project").textContent).toBe("almadel-web"))
  })
})
