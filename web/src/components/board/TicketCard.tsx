import { useMemo } from "react"
import { BotIcon, GitBranchIcon, PencilIcon } from "lucide-react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Ticket } from "@/types/domain"
import { ticketStateLabel, isBlocked } from "@/lib/display"

function stateChip(state: Ticket["state"]): string {
  switch (state) {
    case "running":
      return "bg-success/15 text-success-foreground dark:text-success"
    case "blocked_question":
    case "blocked_permission":
      return "bg-warning/15 text-warning-foreground dark:text-warning"
    case "done":
      return "bg-secondary text-secondary-foreground"
    case "failed":
      return "bg-destructive/10 text-destructive"
    case "ready":
    default:
      return "bg-secondary text-secondary-foreground"
  }
}

export function TicketCard({
  ticket,
  agentName,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
  onEdit,
}: {
  ticket: Ticket
  agentName?: string
  selected: boolean
  onSelect: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onEdit?: () => void
}) {
  const blocked = isBlocked(ticket.state)

  const chip = useMemo(() => stateChip(ticket.state), [ticket.state])

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect()
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group/card flex cursor-grab flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-left shadow-xs transition-colors",
        "hover:border-ring/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        "active:cursor-grabbing",
        selected && "border-ring ring-2 ring-ring/30",
        blocked && "border-warning/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{ticket.id}</span>
        <div className="flex items-center gap-1">
          {onEdit && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Edit ${ticket.title}`}
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
            >
              <PencilIcon data-icon="inline-start" />
            </Button>
          )}
          <Badge className={cn("px-1.5 text-[10px]", chip)}>
            {ticketStateLabel[ticket.state]}
          </Badge>
        </div>
      </div>

      <p className="line-clamp-2 text-sm leading-snug font-medium">{ticket.title}</p>

      {(agentName || ticket.branch) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {agentName && (
            <span className="inline-flex items-center gap-1">
              <BotIcon className="size-3" />
              {agentName}
            </span>
          )}
          {ticket.branch && (
            <span className="inline-flex items-center gap-1 truncate">
              <GitBranchIcon className="size-3" />
              <span className="truncate">{ticket.branch}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
