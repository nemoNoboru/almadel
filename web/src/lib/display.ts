import type { AgentStatus, TicketState } from "@/types/domain"

export function relativeTime(ts: number | null): string {
  if (ts == null) return "—"
  const diff = Date.now() - ts
  const sec = Math.round(diff / 1000)
  if (sec < 5) return "now"
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}

export const ticketStateLabel: Record<TicketState, string> = {
  ready: "ready",
  running: "running",
  blocked_question: "needs answer",
  blocked_permission: "needs decision",
  done: "done",
  failed: "failed",
}

export const agentStatusLabel: Record<AgentStatus, string> = {
  idle: "idle",
  working: "working",
  blocked_question: "blocked",
  blocked_permission: "blocked",
  failed: "failed",
}

export function isBlocked(state: string): boolean {
  return state === "blocked_question" || state === "blocked_permission"
}
