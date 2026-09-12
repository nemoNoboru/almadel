import { useMemo, useState } from "react"
import { toast } from "sonner"
import { cn } from "cn"
import { BotIcon, CornerDownLeftIcon, UserIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useApp } from "@/state/AppProvider"
import type { Message } from "@/api/client"
import { relativeTime, agentStatusLabel } from "@/lib/display"
import { Markdown } from "@/components/Markdown"

export function AgentChatPanel() {
  const {
    selectedAgentId,
    roster,
    messages,
    loadingMessages,
    closeAgentChat,
    sendAgentMessage,
  } = useApp()
  const [body, setBody] = useState("")

  const agent = useMemo(() => {
    if (!selectedAgentId) return null
    for (const group of roster?.projects ?? []) {
      const found = group.agents.find((a) => a.id === selectedAgentId)
      if (found) return found
    }
    return null
  }, [roster, selectedAgentId])

  if (!selectedAgentId) return null

  const send = async () => {
    if (!body.trim()) return
    try {
      await sendAgentMessage(selectedAgentId, body.trim())
      setBody("")
    } catch {
      toast.error("Couldn't send")
    }
  }

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">
              {agent?.name ?? agent?.label ?? "agent"}
            </span>
            {agent && (
              <Badge
                className={cn(
                  "px-1.5 text-[10px]",
                  agent.online
                    ? "bg-secondary text-secondary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {agent.online ? agentStatusLabel[agent.status] : "offline"}
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">direct message</p>
        </div>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close agent chat"
          onClick={closeAgentChat}
        >
          <XIcon data-icon="inline-start" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3 p-3">
          {loadingMessages && messages.length === 0 ? (
            <Skeleton className="h-24 w-full" />
          ) : messages.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No messages yet. Say hi — the agent replies through its opencode session.
            </p>
          ) : (
            messages.map((m) => <MessageRow key={m.id} message={m} />)
          )}
        </div>
      </ScrollArea>

      <div className="flex flex-col gap-2 border-t p-3">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Message the agent…"
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send()
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {agent?.online ? "Sent to the agent's session." : "Agent offline."}
          </span>
          <Button onClick={send} disabled={!body.trim()}>
            Send
            <CornerDownLeftIcon data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </aside>
  )
}

function MessageRow({ message }: { message: Message }) {
  const mine = message.author === "human"
  return (
    <div
      className={cn(
        "flex max-w-[85%] flex-col gap-1",
        mine ? "ml-auto items-end" : "mr-auto items-start",
      )}
    >
      <div
        className={cn(
          "rounded-lg px-3 py-2 text-sm",
          mine ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        <Markdown>{message.body}</Markdown>
      </div>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {mine ? <UserIcon className="size-3" /> : <BotIcon className="size-3" />}
        {relativeTime(message.created_at)}
      </span>
    </div>
  )
}
