// In-process pub/sub. The claim long-poll waits on per-project and per-agent
// channels; the ask/permission long-polls wait on per-id channels. SSE fan-out
// is a separate set of subscribers — a change signal, not a state transport.

type Resolver<T> = (value: T) => void

interface Waiter<T> {
  resolve: Resolver<T>
  alive: boolean
}

export interface Channel<T> {
  wait(key: string, timeoutMs: number): Promise<T | null>
  broadcast(key: string, value: T): boolean
}

export function channel<T>(): Channel<T> {
  const waiters = new Map<string, Set<Waiter<T>>>()

  return {
    wait(key, timeoutMs) {
      return new Promise<T | null>((resolve) => {
        const set = waiters.get(key) ?? new Set<Waiter<T>>()
        const waiter: Waiter<T> = {
          alive: true,
          resolve: (value) => {
            waiter.alive = false
            resolve(value)
          },
        }
        set.add(waiter)
        waiters.set(key, set)
        setTimeout(() => {
          if (waiter.alive) {
            waiter.alive = false
            set.delete(waiter)
            if (set.size === 0) waiters.delete(key)
            resolve(null)
          }
        }, timeoutMs)
      })
    },

    broadcast(key, value) {
      const set = waiters.get(key)
      if (!set || set.size === 0) return false
      let delivered = false
      for (const waiter of [...set]) {
        set.delete(waiter)
        if (waiter.alive) {
          waiter.alive = false
          waiter.resolve(value)
          delivered = true
        }
      }
      if (set.size === 0) waiters.delete(key)
      return delivered
    },
  }
}

// Claim wake channels.
export const projectClaim = channel<void>()
export const agentJobs = channel<void>()

// Ask / permission long-poll channels.
export const questionAnswer = channel<string>()
export const permissionDecision = channel<{ decision: "allow" | "deny"; scope: string }>()

// ---------------------------------------------------------------------------
// SSE fan-out
// ---------------------------------------------------------------------------

export interface SSESub {
  send(event: string, data: string): void
  closed: boolean
}

const rosterSubs = new Set<SSESub>()
const ticketSubs = new Map<string, Set<SSESub>>()

export function addRosterSub(sub: SSESub): void {
  rosterSubs.add(sub)
}

export function removeRosterSub(sub: SSESub): void {
  rosterSubs.delete(sub)
}

export function addTicketSub(ticketId: string, sub: SSESub): void {
  const set = ticketSubs.get(ticketId) ?? new Set<SSESub>()
  set.add(sub)
  ticketSubs.set(ticketId, set)
}

export function removeTicketSub(ticketId: string, sub: SSESub): void {
  const set = ticketSubs.get(ticketId)
  if (!set) return
  set.delete(sub)
  if (set.size === 0) ticketSubs.delete(ticketId)
}

export function broadcastRoster(): void {
  for (const sub of rosterSubs) {
    if (!sub.closed) sub.send("roster", "{}")
  }
}

export function broadcastTicket(ticketId: string, data: string): void {
  const set = ticketSubs.get(ticketId)
  if (!set) return
  for (const sub of set) {
    if (!sub.closed) sub.send("tick", data)
  }
}
