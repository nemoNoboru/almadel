import { useMemo, useState } from "react"
import { SlidersHorizontalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { useApp } from "@/state/AppProvider"
import type { Column as ColumnType, Ticket } from "@/types/domain"
import { isBlocked } from "@/lib/display"
import { Column } from "./Column"
import { NewTicketDialog } from "./NewTicketDialog"
import { ColumnEditorDialog } from "./ColumnEditorDialog"

interface PendingMove {
  ticketId: string
  columnId: string
  destructive: boolean
}

export function Board() {
  const {
    board,
    roster,
    loadingBoard,
    selectedTicketId,
    selectTicket,
    moveTicket,
    cancel,
  } = useApp()

  const [draggingTicketId, setDraggingTicketId] = useState<string | null>(null)
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const [newTicketColumn, setNewTicketColumn] = useState<ColumnType | null>(null)
  const [editing, setEditing] = useState<ColumnType | "pipeline" | null>(null)

  const agentNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of roster?.projects ?? []) {
      for (const agent of group.agents) {
        map.set(agent.id, agent.name ?? agent.label ?? "agent")
      }
    }
    return map
  }, [roster])

  const ticketsByColumn = useMemo(() => {
    const map = new Map<string, Ticket[]>()
    for (const ticket of board?.tickets ?? []) {
      const list = map.get(ticket.column_id) ?? []
      list.push(ticket)
      map.set(ticket.column_id, list)
    }
    return map
  }, [board])

  const ticketById = useMemo(() => {
    const map = new Map<string, Ticket>()
    for (const t of board?.tickets ?? []) map.set(t.id, t)
    return map
  }, [board])

  const handleDragStart = (ticketId: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", ticketId)
    e.dataTransfer.effectAllowed = "move"
    setDraggingTicketId(ticketId)
  }

  const handleDrop = (ticketId: string, columnId: string) => {
    const ticket = ticketById.get(ticketId)
    if (!ticket) return
    if (ticket.column_id === columnId) return

    const destructive = ticket.state === "running" || isBlocked(ticket.state)
    if (destructive) {
      setPendingMove({ ticketId, columnId, destructive: true })
    } else {
      void doMove(ticketId, columnId)
    }
  }

  const doMove = async (ticketId: string, columnId: string) => {
    try {
      await moveTicket(ticketId, columnId)
    } catch {
      toast.error("Couldn't move card — the server rejected it")
    }
  }

  const confirmDestructiveMove = async () => {
    if (!pendingMove) return
    const { ticketId, columnId } = pendingMove
    try {
      await cancel(ticketId)
      await doMove(ticketId, columnId)
    } catch {
      toast.error("Couldn't cancel the running agent")
    } finally {
      setPendingMove(null)
    }
  }

  if (loadingBoard && !board) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    )
  }

  if (!board) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyTitle>No project selected</EmptyTitle>
          <EmptyDescription>
            Create a project or pick one from the roster.
          </EmptyDescription>
        </Empty>
      </div>
    )
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-sm text-muted-foreground">
          {board.project.name}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing("pipeline")}
        >
          <SlidersHorizontalIcon data-icon="inline-start" />
          Edit pipeline
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex h-full items-start gap-2 px-3 pb-3">
          {board.columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              tickets={ticketsByColumn.get(column.id) ?? []}
              agentNames={agentNames}
              selectedTicketId={selectedTicketId}
              draggingTicketId={draggingTicketId}
              onSelect={selectTicket}
              onDragStart={handleDragStart}
              onDragEnd={() => setDraggingTicketId(null)}
              onDrop={handleDrop}
              onEdit={(c) => setEditing(c)}
              onNewTicket={(c) => setNewTicketColumn(c)}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <NewTicketDialog
        open={newTicketColumn != null}
        column={newTicketColumn}
        onOpenChange={(open) => {
          if (!open) setNewTicketColumn(null)
        }}
      />

      <ColumnEditorDialog
        open={editing != null}
        target={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      />

      <AlertDialog
        open={pendingMove?.destructive ?? false}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel the running agent?</AlertDialogTitle>
            <AlertDialogDescription>
              Moving a running or blocked card out of its column first cancels the
              agent working on it. The branch is left in place, but the run stops.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDestructiveMove}>
              Cancel and move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
