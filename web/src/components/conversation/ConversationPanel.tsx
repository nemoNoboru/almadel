import { useMemo, useState } from "react"
import { toast } from "sonner"
import { cn } from "cn"
import {
  BanIcon,
  BotIcon,
  CheckIcon,
  CornerDownLeftIcon,
  GitBranchIcon,
  PencilIcon,
  SendIcon,
  UserIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
import { useApp } from "@/state/AppProvider"
import type { Comment } from "@/types/domain"
import { relativeTime, ticketStateLabel, isBlocked } from "@/lib/display"

export function ConversationPanel() {
  const { selectedTicketId, thread, loadingThread, roster, closeConversation } =
    useApp()

  const agent = useMemo(() => {
    if (!thread?.ticket.agent_id) return null
    for (const group of roster?.projects ?? []) {
      const found = group.agents.find((a) => a.id === thread.ticket.agent_id)
      if (found) return found
    }
    return null
  }, [thread, roster])

  if (!selectedTicketId) {
    return (
      <aside className="flex w-96 shrink-0 flex-col border-l">
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>No conversation open</EmptyTitle>
            <EmptyDescription>
              Click a card on the board or an agent in the roster to see its
              thread.
            </EmptyDescription>
          </Empty>
        </div>
      </aside>
    )
  }

  if (loadingThread && !thread) {
    return (
      <aside className="flex w-96 shrink-0 flex-col gap-2 border-l p-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-10 w-full" />
      </aside>
    )
  }

  if (!thread) {
    return (
      <aside className="flex w-96 shrink-0 flex-col border-l">
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyTitle>Ticket not found</EmptyTitle>
            <EmptyDescription>
              It may have been deleted elsewhere. The board has been refreshed.
            </EmptyDescription>
          </Empty>
        </div>
      </aside>
    )
  }

  const { ticket } = thread
  const blocked = isBlocked(ticket.state)

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {ticket.id}
            </span>
            <Badge
              className={cn(
                "px-1.5 text-[10px]",
                blocked
                  ? "bg-warning/15 text-warning-foreground dark:text-warning"
                  : "bg-secondary text-secondary-foreground",
              )}
            >
              {ticketStateLabel[ticket.state]}
            </Badge>
          </div>
          <p className="truncate text-sm font-medium">{ticket.title}</p>
        </div>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close conversation"
          onClick={closeConversation}
        >
          <XIcon data-icon="inline-start" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3 p-3">
          {agent && !agent.online && (
            <Alert className="text-xs">
              Agent offline — it won't respond until it reconnects.
            </Alert>
          )}

          <Thread ticketId={ticket.id} comments={thread.comments} />

          {thread.pending
            .filter((p) => p.sent_at == null)
            .map((p) => (
              <div
                key={p.id}
                className="ml-auto flex max-w-[85%] flex-col items-end gap-1"
              >
                <div className="rounded-lg border border-dashed bg-card px-3 py-2 text-sm">
                  {p.body}
                </div>
                <span className="text-xs text-muted-foreground">
                  queued — delivered when the turn ends
                </span>
              </div>
            ))}
        </div>
      </ScrollArea>

      <ComposeArea key={ticket.id} ticketId={ticket.id} agentOnline={agent?.online ?? false} />
    </aside>
  )
}

function Thread({ ticketId, comments }: { ticketId: string; comments: Comment[] }) {
  if (comments.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No activity yet.
      </p>
    )
  }

  return (
    <>
      {comments.map((c) => (
        <CommentRow key={c.id} ticketId={ticketId} comment={c} />
      ))}
    </>
  )
}

function CommentRow({ ticketId, comment }: { ticketId: string; comment: Comment }) {
  const { updateComment } = useApp()
  const mine = comment.author === "human"
  const system = comment.author === "system"
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body ?? "")

  if (system) {
    return (
      <p className="text-center text-xs text-muted-foreground">{comment.body}</p>
    )
  }

  const save = async () => {
    if (!draft.trim()) return
    try {
      await updateComment(ticketId, comment.id, draft.trim())
      setEditing(false)
    } catch {
      toast.error("Couldn't save edit")
    }
  }

  const cancel = () => {
    setDraft(comment.body ?? "")
    setEditing(false)
  }

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
          mine
            ? "bg-primary text-primary-foreground"
            : "bg-muted",
          comment.kind === "question" && "bg-warning/15 text-warning-foreground dark:text-warning",
          comment.kind === "plan" && "border bg-card",
          comment.kind === "permission" && "border bg-card",
        )}
      >
        {comment.kind === "question" && (
          <div className="mb-1 flex items-center gap-1 text-xs font-medium">
            <BotIcon className="size-3" /> question
          </div>
        )}
        {comment.kind === "plan" && (
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            plan
          </div>
        )}
        {comment.kind === "permission" && (
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            permission
          </div>
        )}
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Escape") cancel()
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save()
              }}
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={!draft.trim()}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap">{comment.body}</p>
        )}
      </div>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {mine ? <UserIcon className="size-3" /> : <BotIcon className="size-3" />}
        {relativeTime(comment.created_at)}
        {comment.updated_at != null && <span>· edited</span>}
        {!editing && (
          <button
            type="button"
            aria-label="Edit comment"
            className="ml-1 inline-flex items-center gap-0.5 hover:text-foreground"
            onClick={() => {
              setDraft(comment.body ?? "")
              setEditing(true)
            }}
          >
            <PencilIcon className="size-3" />
            Edit
          </button>
        )}
      </span>
    </div>
  )
}

function ComposeArea({
  ticketId,
  agentOnline,
}: {
  ticketId: string
  agentOnline: boolean
}) {
  const { thread, reply, decidePermission, cancel, takeover } = useApp()
  const [body, setBody] = useState("")
  const [scope, setScope] = useState<"once" | "always" | "session">("once")
  const [confirming, setConfirming] = useState<"cancel" | "takeover" | null>(null)

  if (!thread) return null
  const { ticket } = thread
  const state = ticket.state

  const send = async () => {
    if (!body.trim()) return
    try {
      await reply(ticketId, body.trim())
      setBody("")
    } catch {
      toast.error("Couldn't send")
    }
  }

  const decide = async (decision: "allow" | "deny") => {
    try {
      await decidePermission(ticketId, decision, scope)
      toast.success(decision === "allow" ? "Allowed" : "Denied")
    } catch {
      toast.error("Couldn't record the decision")
    }
  }

  const confirmAction = async () => {
    if (!confirming) return
    try {
      if (confirming === "cancel") await cancel(ticketId)
      else await takeover(ticketId)
      toast.success(confirming === "cancel" ? "Cancelled" : "Taken over")
    } catch {
      toast.error("Action failed")
    } finally {
      setConfirming(null)
    }
  }

  const readOnly = state === "ready" || state === "done" || state === "failed"
  const commentOnly = readOnly || !agentOnline

  return (
    <div className="flex flex-col gap-2 border-t p-3">
      {state === "blocked_permission" && agentOnline ? (
        <PermissionControls
          command={thread.permission?.command ?? null}
          scope={scope}
          setScope={setScope}
          onAllow={() => decide("allow")}
          onDeny={() => decide("deny")}
        />
      ) : state === "blocked_question" && agentOnline ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Answer the agent…"
            rows={3}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send()
            }}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Reply is injected into the held session — full context survives.
            </span>
            <Button onClick={send} disabled={!body.trim()}>
              Reply
              <CornerDownLeftIcon data-icon="inline-end" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={commentOnly ? "Add a comment…" : "Message the agent…"}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send()
            }}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {commentOnly
                ? "No live agent — this comment stays on the ticket."
                : "Agent is working — this is queued until the turn ends."}
            </span>
            <Button onClick={send} disabled={!body.trim()}>
              {commentOnly ? "Comment" : "Queue"}
              <SendIcon data-icon="inline-end" />
            </Button>
          </div>
        </div>
      )}

      {state !== "done" && state !== "failed" && (
        <>
          <Separator />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirming("cancel")}>
              <BanIcon data-icon="inline-start" />
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirming("takeover")}>
              <GitBranchIcon data-icon="inline-start" />
              Take over
            </Button>
          </div>
        </>
      )}

      <p className="text-center text-xs text-muted-foreground/80">
        Everything here is on the ticket — the next agent reads it.
      </p>

      <AlertDialog
        open={confirming != null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "cancel" ? "Cancel the run?" : "Take over the ticket?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "cancel"
                ? "This interrupts the agent and ends the run. The branch is left in place."
                : "This marks the ticket human-owned and leaves the branch checked out so you can open it yourself."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction onClick={confirmAction}>
              {confirming === "cancel" ? "Cancel run" : "Take over"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PermissionControls({
  command,
  scope,
  setScope,
  onAllow,
  onDeny,
}: {
  command: string | null
  scope: "once" | "always" | "session"
  setScope: (s: "once" | "always" | "session") => void
  onAllow: () => void
  onDeny: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {command && (
        <Alert className="text-xs">
          <code className="block break-all font-mono">{command}</code>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          value={scope}
          onValueChange={(v) => {
            if (v) setScope(v as "once" | "always" | "session")
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="once">once</ToggleGroupItem>
          <ToggleGroupItem value="always">always</ToggleGroupItem>
          <ToggleGroupItem value="session">session</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={onAllow}>
          <CheckIcon data-icon="inline-start" />
          Allow
        </Button>
        <Button variant="destructive" className="flex-1" onClick={onDeny}>
          <XIcon data-icon="inline-start" />
          Deny
        </Button>
      </div>
    </div>
  )
}
