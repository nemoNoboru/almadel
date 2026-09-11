import { useMemo, useState } from "react"
import { BotIcon, HandIcon, PencilIcon, PlusIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import type { Column as ColumnType, Ticket } from "@/types/domain"
import { TicketCard } from "./TicketCard"

export function Column({
  column,
  tickets,
  agentNames,
  selectedTicketId,
  draggingTicketId,
  onSelect,
  onDragStart,
  onDragEnd,
  onDrop,
  onEdit,
  onNewTicket,
}: {
  column: ColumnType
  tickets: Ticket[]
  agentNames: Map<string, string>
  selectedTicketId: string | null
  draggingTicketId: string | null
  onSelect: (id: string) => void
  onDragStart: (ticketId: string) => (e: React.DragEvent) => void
  onDragEnd: () => void
  onDrop: (ticketId: string, columnId: string) => void
  onEdit: (column: ColumnType) => void
  onNewTicket: (column: ColumnType) => void
}) {
  const prompted = column.prompt != null

  const inProgress = useMemo(
    () => tickets.filter((t) => t.state === "running" || t.state.startsWith("blocked")),
    [tickets],
  )

  const full = column.wip_limit != null && inProgress.length >= column.wip_limit
  const isDropTarget = draggingTicketId != null
  const reject = full && isDropTarget

  const [over, setOver] = useState(false)

  return (
    <div className="flex w-64 shrink-0 flex-col">
      <div className="flex items-center gap-2 px-1 py-2">
        <span className="text-sm font-medium">{column.name}</span>
        {prompted ? (
          <span className="inline-flex items-center gap-1 text-xs text-success-foreground dark:text-success">
            <BotIcon className="size-3.5" />
            auto
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <HandIcon className="size-3.5" />
            manual
          </span>
        )}

        <div className="flex-1" />

        {column.wip_limit != null && (
          <span
            className={cn(
              "text-xs text-muted-foreground",
              full && "font-medium text-warning",
            )}
          >
            {inProgress.length}/{column.wip_limit}
            {full && " FULL"}
          </span>
        )}

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Edit ${column.name}`}
          onClick={() => onEdit(column)}
        >
          <PencilIcon data-icon="inline-start" />
        </Button>
      </div>

      <div
        data-testid={`column-drop-${column.id}`}
        onDragOver={(e) => {
          if (!reject) {
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            setOver(true)
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const ticketId = e.dataTransfer.getData("text/plain")
          if (ticketId && !full) onDrop(ticketId, column.id)
        }}
        className={cn(
          "flex flex-1 flex-col gap-1.5 rounded-lg border border-dashed border-transparent p-1",
          over && "border-ring/50 bg-muted/40",
          reject && "cursor-not-allowed",
        )}
      >
        {tickets.map((ticket) => (
          <TicketCard
            key={ticket.id}
            ticket={ticket}
            agentName={ticket.agent_id ? agentNames.get(ticket.agent_id) : undefined}
            selected={ticket.id === selectedTicketId}
            onSelect={() => onSelect(ticket.id)}
            onDragStart={onDragStart(ticket.id)}
            onDragEnd={onDragEnd}
          />
        ))}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 justify-start text-muted-foreground"
          onClick={() => onNewTicket(column)}
        >
          <PlusIcon data-icon="inline-start" />
          New card
        </Button>
      </div>
    </div>
  )
}
