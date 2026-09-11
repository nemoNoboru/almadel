// Runtime configuration, resolved from the environment with sane self-hosted defaults.

export interface Config {
  host: string
  port: number
  dbPath: string
  staticDir: string | null

  // Long-poll window for /api/claim. Must sit under the ingress idle timeout.
  pollWindowMs: number
  // An agent is "online" iff last_poll is fresher than this.
  leaseTtlMs: number
  // How often the sweep runs (lease expiry + permission auto-deny).
  sweepIntervalMs: number
  // almadel_ask fast-path window before deferring to message injection.
  askTimeoutMs: number
  // Permission requests auto-deny after this.
  permissionTtlMs: number

  // Port-band allocation for slots (§09).
  portBase: number
  portBandWidth: number

  // Minimum opencode version required at registration (capability gate).
  minOpencodeVersion: string
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env.ALMADEL_HOST ?? "127.0.0.1",
    port: int(env.ALMADEL_PORT, 1213),
    dbPath: env.ALMADEL_DB ?? defaultDbPath(),
    staticDir: env.ALMADEL_STATIC ?? defaultStaticDir(),

    pollWindowMs: int(env.ALMADEL_POLL_WINDOW, 35_000),
    leaseTtlMs: int(env.ALMADEL_LEASE_TTL, 90_000),
    sweepIntervalMs: int(env.ALMADEL_SWEEP_INTERVAL, 15_000),
    askTimeoutMs: int(env.ALMADEL_ASK_TIMEOUT, 5 * 60_000),
    permissionTtlMs: int(env.ALMADEL_PERMISSION_TTL, 60 * 60_000),

    portBase: int(env.ALMADEL_PORT_BASE, 8000),
    portBandWidth: int(env.ALMADEL_PORT_BAND_WIDTH, 100),

    minOpencodeVersion: env.ALMADEL_MIN_OPENCODE_VERSION ?? "1.0.0",
  }
}

function int(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

function defaultDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "."
  return `${home}/.almadel/almadel.db`
}

function defaultStaticDir(): string | null {
  // The embedded UI. Served if present; otherwise the server runs headless.
  const candidates = [
    process.env.ALMADEL_STATIC,
    // Relative to the server package source: <repo>/web/dist
    new URL("../../web/dist", import.meta.url).pathname,
    new URL("../web/dist", import.meta.url).pathname,
    // Bundled UI shipped inside the server package (see scripts/build-ui.ts).
    new URL("../ui", import.meta.url).pathname,
  ].filter((c): c is string => typeof c === "string" && c.length > 0)

  for (const candidate of candidates) {
    const stat = statDir(candidate)
    if (stat) return stat
  }
  return null
}

function statDir(path: string): string | null {
  try {
    const files = Array.from(new Bun.Glob("*").scanSync({ cwd: path, onlyFiles: true }))
    return files.length > 0 ? path : null
  } catch {
    return null
  }
}
