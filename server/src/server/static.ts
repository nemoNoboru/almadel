// Serves the embedded UI with an SPA fallback so client-side routes (/p/:id,
// /join) resolve to index.html. Returns null when nothing matches.
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
}

export function serveStatic(
  staticDir: string | null,
  request: Request,
): Response | null {
  if (!staticDir) return null

  const url = new URL(request.url)
  if (request.method !== "GET" && request.method !== "HEAD") return null

  const pathname = decodeURIComponent(url.pathname)
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const filePath = `${staticDir}/${relative}`

  const file = Bun.file(filePath)
  // Bun.file doesn't throw for missing files; check size against a HEAD.
  if (file.size === 0 && !exists(staticDir, relative)) {
    // SPA fallback for non-file routes.
    if (!relative.includes(".")) {
      const index = Bun.file(`${staticDir}/index.html`)
      if (index.size > 0) return new Response(index)
    }
    return null
  }

  const ext = relative.includes(".") ? relative.slice(relative.lastIndexOf(".")) : ""
  return new Response(file, {
    headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
  })
}

function exists(staticDir: string, relative: string): boolean {
  try {
    const files = new Bun.Glob(relative).scanSync({ cwd: staticDir, onlyFiles: true })
    for (const _ of files) return true
    return false
  } catch {
    return false
  }
}
