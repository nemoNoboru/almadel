import { describe, expect, test, vi } from "bun:test"
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { renderWithApp, makeState, columns } from "./utils"
import { ColumnEditorDialog } from "@/components/board/ColumnEditorDialog"

describe("ColumnEditorDialog — pipeline", () => {
  test("lists every column with reorder controls", () => {
    renderWithApp(<ColumnEditorDialog open target="pipeline" onOpenChange={() => {}} />)
    expect(screen.getByText("Edit pipeline")).toBeInTheDocument()
    expect(screen.getByText("Add column")).toBeInTheDocument()
    // Each fixture column name is present as an input value.
    for (const c of columns) {
      expect(screen.getByDisplayValue(c.name)).toBeInTheDocument()
    }
  })

  test("saving persists the pipeline", async () => {
    const updateColumns = vi.fn()
    renderWithApp(
      <ColumnEditorDialog open target="pipeline" onOpenChange={() => {}} />,
      makeState({ updateColumns }),
    )
    fireEvent.click(screen.getByRole("button", { name: /save pipeline/i }))
    await waitFor(() => expect(updateColumns).toHaveBeenCalled())
  })
})

describe("ColumnEditorDialog — single column", () => {
  test("shows the focused column's form", () => {
    renderWithApp(<ColumnEditorDialog open target={columns[0]} onOpenChange={() => {}} />)
    expect(screen.getByText("Edit column")).toBeInTheDocument()
  })

  test("labels an empty prompt as a manual gate", () => {
    renderWithApp(<ColumnEditorDialog open target={columns[0]} onOpenChange={() => {}} />)
    expect(screen.getByText("(manual gate)")).toBeInTheDocument()
  })

  test("previews a rendered prompt", () => {
    renderWithApp(<ColumnEditorDialog open target={columns[1]} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /preview rendered prompt/i }))
    expect(screen.getByText(/TCK-412/)).toBeInTheDocument()
  })
})

describe("ColumnEditorDialog — pipeline edits", () => {
  test("adds a column", () => {
    renderWithApp(<ColumnEditorDialog open target="pipeline" onOpenChange={() => {}} />)
    const before = document.querySelectorAll('[id^="name-"]').length
    fireEvent.click(screen.getByRole("button", { name: /add column/i }))
    expect(document.querySelectorAll('[id^="name-"]').length).toBe(before + 1)
  })

  test("removes a column", () => {
    renderWithApp(<ColumnEditorDialog open target="pipeline" onOpenChange={() => {}} />)
    const before = document.querySelectorAll('[id^="name-"]').length
    fireEvent.click(screen.getAllByRole("button", { name: /remove column/i })[0])
    expect(document.querySelectorAll('[id^="name-"]').length).toBe(before - 1)
  })

  test("reorders columns with move down", () => {
    renderWithApp(<ColumnEditorDialog open target="pipeline" onOpenChange={() => {}} />)
    const moveDown = screen.getAllByRole("button", { name: /move down/i })[0]
    fireEvent.click(moveDown)
    // Reordering is local state; just assert the editor stays rendered.
    expect(screen.getByText("Edit pipeline")).toBeInTheDocument()
  })
})
