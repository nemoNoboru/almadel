import { describe, expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Markdown } from "@/components/Markdown"

describe("Markdown", () => {
  test("renders a heading as an h2, not raw text", () => {
    const { container } = render(<Markdown>{"## Heading"}</Markdown>)
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Heading")
    expect(container.textContent).not.toContain("##")
  })

  test("renders an unordered list with two items", () => {
    const { container } = render(<Markdown>{"- a\n- b"}</Markdown>)
    const ul = container.querySelector("ul")
    expect(ul).not.toBeNull()
    expect(ul?.querySelectorAll("li")).toHaveLength(2)
  })

  test("renders an ordered list", () => {
    const { container } = render(<Markdown>{"1. a\n2. b"}</Markdown>)
    const ol = container.querySelector("ol")
    expect(ol).not.toBeNull()
    expect(ol?.querySelectorAll("li")).toHaveLength(2)
  })

  test("renders fenced code inside a pre/code block", () => {
    const { container } = render(<Markdown>{"```js\nconst x = 1\n```"}</Markdown>)
    const code = container.querySelector("pre code")
    expect(code).not.toBeNull()
    expect(code?.textContent).toContain("const x = 1")
  })

  test("renders inline code with a code element", () => {
    const { container } = render(<Markdown>{"use `foo` here"}</Markdown>)
    expect(container.querySelector("code")).toHaveTextContent("foo")
    expect(container.querySelector("pre")).toBeNull()
  })

  test("renders links and bold text", () => {
    const { container } = render(<Markdown>{"**bold** and [link](https://example.com)"}</Markdown>)
    expect(container.querySelector("strong")).toHaveTextContent("bold")
    expect(container.querySelector("a")).toHaveAttribute("href", "https://example.com")
  })

  test("escapes raw HTML so script cannot execute", () => {
    const { container } = render(<Markdown>{"<script>alert(1)</script>"}</Markdown>)
    expect(container.querySelector("script")).toBeNull()
  })

  test("renders plain text without markdown as-is", () => {
    render(<Markdown>{"just plain text"}</Markdown>)
    expect(screen.getByText("just plain text")).toBeInTheDocument()
  })

  test("renders an empty body as empty", () => {
    const { container } = render(<Markdown>{null}</Markdown>)
    expect(container.textContent).toBe("")
  })
})
