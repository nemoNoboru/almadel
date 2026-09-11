import { describe, expect, test } from "bun:test"
import { ApiError } from "@/api/client"

describe("ApiError", () => {
  test("exposes status, message and issues", () => {
    const err = new ApiError(400, "bad request", [
      { path: "title", message: "required" },
    ])
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("ApiError")
    expect(err.status).toBe(400)
    expect(err.message).toBe("bad request")
    expect(err.issues).toHaveLength(1)
  })

  test("defaults issues to empty", () => {
    const err = new ApiError(500, "boom")
    expect(err.issues).toEqual([])
  })
})
