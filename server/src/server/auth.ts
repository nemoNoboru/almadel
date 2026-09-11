import type { DB } from "../db"
import type { Agent } from "../types"
import { getAgentByToken } from "../domain/agents"

// Resolves a Bearer registration token to its agent. Returns null when absent
// or invalid — the router treats "no token" as the browser (no auth) and
// "invalid token" as 401 on plugin-facing routes.
export function resolveBearer(db: DB, request: Request): Agent | null {
  const header = request.headers.get("Authorization")
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return null
  return getAgentByToken(db, match[1]!)
}

export function hasBearer(request: Request): boolean {
  return request.headers.get("Authorization") != null
}
