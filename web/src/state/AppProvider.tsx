import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { client } from "@/api"
import type { Message } from "@/api/client"
import type { Column, Roster, Board, TicketThread } from "@/types/domain"

interface ProjectRef {
  id: string
  name: string
}

export interface MoveOptions {
  note?: string
}

export interface AppState {
  projects: ProjectRef[]
  roster: Roster | null
  board: Board | null
  selectedProjectId: string | null
  selectedTicketId: string | null
  selectedAgentId: string | null
  thread: TicketThread | null
  messages: Message[]
  loadingRoster: boolean
  loadingBoard: boolean
  loadingThread: boolean
  loadingMessages: boolean
  error: string | null

  selectProject: (id: string) => void
  selectTicket: (id: string) => void
  selectAgent: (id: string) => void
  closeConversation: () => void
  closeAgentChat: () => void
  sendAgentMessage: (agentId: string, body: string) => Promise<void>
  moveTicket: (ticketId: string, columnId: string, opts?: MoveOptions) => Promise<void>
  createTicket: (input: {
    project_id: string
    title: string
    body: string
    column_id: string
  }) => Promise<void>
  reply: (ticketId: string, body: string) => Promise<void>
  decidePermission: (
    ticketId: string,
    decision: "allow" | "deny",
    scope: "once" | "always" | "session",
  ) => Promise<void>
  cancel: (ticketId: string) => Promise<void>
  takeover: (ticketId: string) => Promise<void>
  updateColumns: (projectId: string, columns: Column[]) => Promise<void>
}

const AppContext = createContext<AppState | null>(null)

export { AppContext }

export function AppProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectRef[]>([])
  const [roster, setRoster] = useState<Roster | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [thread, setThread] = useState<TicketThread | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loadingRoster, setLoadingRoster] = useState(true)
  const [loadingBoard, setLoadingBoard] = useState(false)
  const [loadingThread, setLoadingThread] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refs so stream callbacks read current values without re-subscribing.
  const selectedTicketRef = useRef<string | null>(null)
  const selectedProjectRef = useRef<string | null>(null)
  const selectedAgentRef = useRef<string | null>(null)

  useEffect(() => {
    selectedTicketRef.current = selectedTicketId
    selectedProjectRef.current = selectedProjectId
    selectedAgentRef.current = selectedAgentId
  })

  const refreshRoster = useCallback(async () => {
    try {
      const r = await client.getRoster()
      setRoster(r)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load roster")
    } finally {
      setLoadingRoster(false)
    }
  }, [])

  const refreshBoard = useCallback(async (projectId: string) => {
    setLoadingBoard(true)
    try {
      const b = await client.getBoard(projectId)
      setBoard(b)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load board")
    } finally {
      setLoadingBoard(false)
    }
  }, [])

  const refreshThread = useCallback(async (ticketId: string) => {
    setLoadingThread(true)
    try {
      const t = await client.getTicketThread(ticketId)
      setThread(t)
      setError(null)
    } catch {
      // Ticket may have been deleted elsewhere — clear the pin.
      setThread(null)
      setSelectedTicketId(null)
    } finally {
      setLoadingThread(false)
    }
  }, [])

  // Initial load: list projects, pick the first, then roster + board.
  useEffect(() => {
    client.listProjects().then((ps) => {
      setProjects(ps)
      if (ps.length > 0) setSelectedProjectId(ps[0].id)
    })
    refreshRoster()
  }, [refreshRoster])

  useEffect(() => {
    if (selectedProjectId) refreshBoard(selectedProjectId)
  }, [selectedProjectId, refreshBoard])

  // Roster stream: re-fetch the query on any hint ("query is the truth").
  useEffect(() => {
    const handle = client.subscribe((e) => {
      if (e.type === "roster") {
        refreshRoster()
        if (selectedProjectRef.current) refreshBoard(selectedProjectRef.current)
        if (selectedTicketRef.current) refreshThread(selectedTicketRef.current)
      } else if (e.type === "board") {
        if (selectedProjectRef.current === e.project_id) {
          refreshBoard(e.project_id)
        }
      } else if (e.type === "ticket") {
        if (selectedTicketRef.current === e.ticket_id) {
          refreshThread(e.ticket_id)
        }
        if (selectedProjectRef.current) refreshBoard(selectedProjectRef.current)
        refreshRoster()
      }
    })
    return () => handle.unsubscribe()
  }, [refreshRoster, refreshBoard, refreshThread])

  const refreshMessages = useCallback(async (agentId: string) => {
    setLoadingMessages(true)
    try {
      const msgs = await client.listMessages(agentId)
      setMessages(msgs)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load messages")
    } finally {
      setLoadingMessages(false)
    }
  }, [])

  const selectProject = useCallback((id: string) => {
    setSelectedProjectId(id)
  }, [])

  const selectTicket = useCallback(
    (id: string) => {
      setSelectedTicketId(id)
      setSelectedAgentId(null)
      refreshThread(id)
    },
    [refreshThread],
  )

  const selectAgent = useCallback(
    (id: string) => {
      setSelectedAgentId(id)
      setSelectedTicketId(null)
      setThread(null)
      refreshMessages(id)
    },
    [refreshMessages],
  )

  const closeConversation = useCallback(() => {
    setSelectedTicketId(null)
    setThread(null)
  }, [])

  const closeAgentChat = useCallback(() => {
    setSelectedAgentId(null)
    setMessages([])
  }, [])

  const sendAgentMessage = useCallback(
    async (agentId: string, body: string) => {
      await client.sendMessage(agentId, body)
      await refreshMessages(agentId)
    },
    [refreshMessages],
  )

  // Poll the open agent chat so replies stream in without manual refresh.
  useEffect(() => {
    if (!selectedAgentId) return
    const id = setInterval(() => {
      if (selectedAgentRef.current) refreshMessages(selectedAgentRef.current)
    }, 2000)
    return () => clearInterval(id)
  }, [selectedAgentId, refreshMessages])

  const moveTicket = useCallback(
    async (ticketId: string, columnId: string, opts?: MoveOptions) => {
      // Optimistic: place the card immediately, reconcile on the stream tick.
      setBoard((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          tickets: prev.tickets.map((t) =>
            t.id === ticketId ? { ...t, column_id: columnId } : t,
          ),
        }
      })
      try {
        await client.moveTicket(ticketId, { column: columnId, note: opts?.note })
      } catch {
        // Snap back via authoritative re-fetch.
        if (selectedProjectRef.current) refreshBoard(selectedProjectRef.current)
        throw new Error("move failed")
      }
      if (selectedProjectRef.current) refreshBoard(selectedProjectRef.current)
      if (selectedTicketRef.current === ticketId) refreshThread(ticketId)
    },
    [refreshBoard, refreshThread],
  )

  const createTicket = useCallback(
    async (input: {
      project_id: string
      title: string
      body: string
      column_id: string
    }) => {
      await client.createTicket(input)
      if (selectedProjectRef.current === input.project_id) {
        refreshBoard(input.project_id)
      }
    },
    [refreshBoard],
  )

  const reply = useCallback(
    async (ticketId: string, body: string) => {
      await client.reply(ticketId, body)
      if (selectedTicketRef.current === ticketId) refreshThread(ticketId)
      refreshRoster()
    },
    [refreshThread, refreshRoster],
  )

  const decidePermission = useCallback(
    async (
      ticketId: string,
      decision: "allow" | "deny",
      scope: "once" | "always" | "session",
    ) => {
      await client.decidePermission(ticketId, decision, scope)
      if (selectedTicketRef.current === ticketId) refreshThread(ticketId)
      refreshRoster()
      if (selectedProjectRef.current) refreshBoard(selectedProjectRef.current)
    },
    [refreshThread, refreshRoster, refreshBoard],
  )

  const cancel = useCallback(
    async (ticketId: string) => {
      await client.cancelTicket(ticketId)
      if (selectedTicketRef.current === ticketId) refreshThread(ticketId)
      refreshRoster()
      if (selectedProjectRef.current) refreshBoard(selectedProjectRef.current)
    },
    [refreshThread, refreshRoster, refreshBoard],
  )

  const takeover = useCallback(
    async (ticketId: string) => {
      await client.takeoverTicket(ticketId)
      if (selectedTicketRef.current === ticketId) refreshThread(ticketId)
      refreshRoster()
      if (selectedProjectRef.current) refreshBoard(selectedProjectRef.current)
    },
    [refreshThread, refreshRoster, refreshBoard],
  )

  const updateColumns = useCallback(
    async (projectId: string, columns: Column[]) => {
      await client.updateColumns(projectId, columns)
      if (selectedProjectRef.current === projectId) refreshBoard(projectId)
    },
    [refreshBoard],
  )

  const value = useMemo<AppState>(
    () => ({
      projects,
      roster,
      board,
      selectedProjectId,
      selectedTicketId,
      selectedAgentId,
      thread,
      messages,
      loadingRoster,
      loadingBoard,
      loadingThread,
      loadingMessages,
      error,
      selectProject,
      selectTicket,
      selectAgent,
      closeConversation,
      closeAgentChat,
      sendAgentMessage,
      moveTicket,
      createTicket,
      reply,
      decidePermission,
      cancel,
      takeover,
      updateColumns,
    }),
    [
      projects,
      roster,
      board,
      selectedProjectId,
      selectedTicketId,
      selectedAgentId,
      thread,
      messages,
      loadingRoster,
      loadingBoard,
      loadingThread,
      loadingMessages,
      error,
      selectProject,
      selectTicket,
      selectAgent,
      closeConversation,
      closeAgentChat,
      sendAgentMessage,
      moveTicket,
      createTicket,
      reply,
      decidePermission,
      cancel,
      takeover,
      updateColumns,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error("useApp must be used within AppProvider")
  return ctx
}
