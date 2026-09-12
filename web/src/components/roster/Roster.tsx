import { useNavigate } from "react-router-dom"
import { FlameIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { useApp } from "@/state/AppProvider"
import type { Agent } from "@/types/domain"
import { agentStatusLabel, isBlocked } from "@/lib/display"

export function Roster() {
  const { roster, selectedProjectId, selectProject, selectAgent, selectedAgentId } =
    useApp()
  const navigate = useNavigate()

  if (!roster) return <div className="w-56 shrink-0 border-r" />

  return (
    <aside className="flex min-h-0 w-56 shrink-0 flex-col border-r">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 p-2">
          {roster.projects.map((group) => (
            <div key={group.project.id} className="flex flex-col gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 justify-start px-2 font-medium text-muted-foreground",
                  group.project.id === selectedProjectId && "text-foreground",
                )}
                onClick={() => {
                  selectProject(group.project.id)
                  navigate(`/p/${group.project.id}`)
                }}
              >
                {group.project.name}
              </Button>

              {group.agents.length === 0 ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  no agents joined
                </p>
              ) : (
                group.agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    active={agent.id === selectedAgentId}
                    onClick={() => selectAgent(agent.id)}
                  />
                ))
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      <Separator />
      <div className="flex items-center justify-between p-2">
        <span className="text-xs text-muted-foreground">
          {roster.needs_you > 0 ? "Needs you" : "All clear"}
        </span>
        {roster.needs_you > 0 && (
          <Badge className="bg-warning/15 text-warning-foreground dark:text-warning">
            {roster.needs_you}
          </Badge>
        )}
      </div>
    </aside>
  )
}

function AgentRow({
  agent,
  active,
  onClick,
}: {
  agent: Agent
  active: boolean
  onClick: () => void
}) {
  const blocked = isBlocked(agent.status)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active && "bg-muted",
        !agent.online && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          agent.online ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
      <span className="flex-1 truncate font-medium">
        {agent.name ?? agent.label ?? "agent"}
        <span className="sr-only">
          {agent.online ? "online" : "offline"}
        </span>
      </span>
      {blocked && <FlameIcon className="size-3.5 text-warning" aria-label="blocked" />}
      <span className="truncate text-xs text-muted-foreground">
        {agent.online ? agentStatusLabel[agent.status] : "offline"}
      </span>
    </button>
  )
}
