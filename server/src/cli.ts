#!/usr/bin/env bun
import { loadConfig } from "./config"
import { openDb, seed } from "./db"
import { startServer } from "./index"

const args = process.argv.slice(2)
const command = args[0] ?? "serve"
const config = loadConfig()

if (command === "init") {
  const db = openDb(config.dbPath)
  seed(db)
  console.log(`Almadel initialised: ${config.dbPath}`)
  db.close()
  process.exit(0)
}

if (command !== "serve" && command !== "start") {
  console.error(`unknown command: ${command}`)
  console.error("usage: almadel [serve|init]")
  process.exit(1)
}

const db = openDb(config.dbPath)
seed(db)

const server = startServer(db, config)
console.log(`Almadel listening on http://${config.host}:${config.port}`)
console.log(`database: ${config.dbPath}`)
if (config.staticDir) console.log(`ui: ${config.staticDir}`)

const shutdown = () => {
  server.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
