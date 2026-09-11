// Minimal SSE helper for Bun. Returns a Response whose body is a ReadableStream
// plus send/close handles. A heartbeat comment defeats idle-kill proxies.
export interface SSEStream {
  send(event: string, data: string): void
  close(): void
  closed: boolean
}

export function createSSE(request: Request): { stream: SSEStream; response: Response } {
  const encoder = new TextEncoder()
  let closed = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      c.enqueue(encoder.encode(": connected\n\n"))
    },
    cancel() {
      closed = true
    },
  })

  const ping = setInterval(() => {
    if (!closed && controller) {
      try {
        controller.enqueue(encoder.encode(": ping\n\n"))
      } catch {
        /* ignore */
      }
    }
  }, 15_000)

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(ping)
    try {
      controller?.close()
    } catch {
      /* ignore */
    }
  }

  request.signal.addEventListener("abort", close)

  const send = (event: string, data: string) => {
    if (closed || !controller) return
    try {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
    } catch {
      close()
    }
  }

  const response = new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })

  return { stream: { send, close, get closed() { return closed } }, response }
}
