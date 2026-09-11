import type { Config } from "./config"
import type { DB } from "./db"
import { sweep } from "./domain/lease"
import { handleApi } from "./server/router"
import { serveStatic } from "./server/static"

export interface RunningServer {
  stop(): void
}

// Starts the HTTP server plus the periodic lease/permission sweep. The server
// is purely inbound: it never dials an agent, never talks to opencode.
export function startServer(db: DB, config: Config): RunningServer {
  const timer = setInterval(() => sweep(db, config), config.sweepIntervalMs)
  if (typeof timer.unref === "function") timer.unref()

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(request) {
      const apiResponse = await handleApi(db, config, request)
      if (apiResponse) return apiResponse

      const staticResponse = serveStatic(config.staticDir, request)
      if (staticResponse) return staticResponse

      return new Response("Not found", { status: 404 })
    },
  })

  return {
    stop() {
      clearInterval(timer)
      server.stop(true)
    },
  }
}
