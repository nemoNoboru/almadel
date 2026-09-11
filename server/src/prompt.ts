import type { Comment } from "./types"

// Renders the column prompt at dispatch time (§4.2) so the agent starts with
// everything and needs no fetch to begin.
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key]
    return value === undefined ? match : value
  })
}

// Builds the {{thread}} variable from the ticket's comment rows. The durable
// artifact history — the same rows the card renders and the next stage's
// prompt inlines (§5.6).
export function buildThread(comments: Comment[]): string {
  if (comments.length === 0) return ""
  return comments
    .map((c) => {
      const label = `${c.kind} (${c.author})`
      return `## ${label}\n${c.body ?? ""}`
    })
    .join("\n\n")
}
