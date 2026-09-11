import { describe, expect, test } from "bun:test"
import {
  agentStatusLabel,
  isBlocked,
  relativeTime,
  ticketStateLabel,
} from "@/lib/display"

describe("relativeTime", () => {
  test("null returns em dash", () => {
    expect(relativeTime(null)).toBe("—")
  })

  test("recent returns now", () => {
    expect(relativeTime(Date.now() - 2000)).toBe("now")
  })

  test("seconds", () => {
    expect(relativeTime(Date.now() - 30_000)).toBe("30s ago")
  })

  test("minutes", () => {
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe("5m ago")
  })

  test("hours", () => {
    expect(relativeTime(Date.now() - 3 * 60 * 60_000)).toBe("3h ago")
  })

  test("days", () => {
    expect(relativeTime(Date.now() - 4 * 24 * 60 * 60_000)).toBe("4d ago")
  })
})

describe("ticketStateLabel", () => {
  test("maps every state", () => {
    expect(ticketStateLabel.ready).toBe("ready")
    expect(ticketStateLabel.running).toBe("running")
    expect(ticketStateLabel.blocked_question).toBe("needs answer")
    expect(ticketStateLabel.blocked_permission).toBe("needs decision")
    expect(ticketStateLabel.done).toBe("done")
    expect(ticketStateLabel.failed).toBe("failed")
  })
})

describe("agentStatusLabel", () => {
  test("maps every status", () => {
    expect(agentStatusLabel.idle).toBe("idle")
    expect(agentStatusLabel.working).toBe("working")
    expect(agentStatusLabel.blocked_question).toBe("blocked")
    expect(agentStatusLabel.blocked_permission).toBe("blocked")
    expect(agentStatusLabel.failed).toBe("failed")
  })
})

describe("isBlocked", () => {
  test("true for both blocked states", () => {
    expect(isBlocked("blocked_question")).toBe(true)
    expect(isBlocked("blocked_permission")).toBe(true)
  })

  test("false otherwise", () => {
    expect(isBlocked("ready")).toBe(false)
    expect(isBlocked("running")).toBe(false)
    expect(isBlocked("done")).toBe(false)
  })
})
