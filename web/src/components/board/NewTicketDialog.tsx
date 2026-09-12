import { useEffect, useMemo, useState } from "react"
import { BotIcon, Loader2Icon, WandIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useApp } from "@/state/AppProvider"
import { client } from "@/api"
import type { Column, Ticket } from "@/types/domain"

type Mode = "write" | "draft"

export function NewTicketDialog({
  open,
  column,
  ticket,
  onOpenChange,
}: {
  open: boolean
  column: Column | null
  ticket?: Ticket | null
  onOpenChange: (open: boolean) => void
}) {
  const { board, roster, createTicket, updateTicket } = useApp()
  const isEdit = ticket != null
  const [mode, setMode] = useState<Mode>("write")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [agentId, setAgentId] = useState("")
  const [instruction, setInstruction] = useState("")
  const [drafting, setDrafting] = useState(false)
  const [draftedBy, setDraftedBy] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setMode("write")
      setTitle(ticket?.title ?? "")
      setBody(ticket?.body ?? "")
      setAgentId("")
      setInstruction("")
      setDraftedBy(null)
    }
  }, [open, ticket])

  const idleAgents = useMemo(() => {
    if (!board || !roster) return []
    const group = roster.projects.find((p) => p.project.id === board.project.id)
    return (
      group?.agents.filter((a) => a.online && a.status === "idle") ?? []
    )
  }, [board, roster])

  if (!board || (!isEdit && !column)) return null

  const prompted = column != null && column.prompt != null

  const runDraft = async () => {
    if (!instruction.trim() || !agentId) return
    setDrafting(true)
    try {
      const draft = await client.draftTicket({
        project_id: board.project.id,
        agent_id: agentId,
        instruction,
      })
      setTitle(draft.title)
      setBody(draft.body)
      setDraftedBy(draft.agent_name)
      toast.success(`Drafted by ${draft.agent_name}`)
    } catch {
      toast.error("Draft failed")
    } finally {
      setDrafting(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    try {
      if (ticket) {
        await updateTicket(ticket.id, { title: title.trim(), body: body.trim() })
        toast.success("Saved")
      } else {
        await createTicket({
          project_id: board.project.id,
          title: title.trim(),
          body: body.trim(),
          column_id: column!.id,
        })
        toast.success(`Created ticket in ${column!.name}`)
      }
      onOpenChange(false)
    } catch {
      toast.error(ticket ? "Couldn't save the ticket" : "Couldn't create the ticket")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit card" : `New card in ${column!.name}`}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the title and body of this card."
              : prompted
                ? "This column is an agent stage — the ticket dispatches as soon as it's created."
                : "This column is a human gate — nothing auto-dispatches."}
          </DialogDescription>
        </DialogHeader>

        {!isEdit && (
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(v) => {
              if (v) setMode(v as Mode)
            }}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="write">Write yourself</ToggleGroupItem>
            <ToggleGroupItem value="draft">
              <WandIcon data-icon="inline-start" />
              Ask an agent to draft
            </ToggleGroupItem>
          </ToggleGroup>
        )}

        {!isEdit && mode === "draft" && (
          <FieldGroup className="rounded-lg border p-3">
            <Field>
              <FieldLabel htmlFor="draft-agent">Agent (idle slot)</FieldLabel>
              {idleAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No idle agents in this project right now.
                </p>
              ) : (
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger id="draft-agent" className="w-full">
                    <SelectValue placeholder="Choose an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {idleAgents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name ?? a.label ?? "agent"}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="draft-instruction">
                What should the card be about?
              </FieldLabel>
              <Textarea
                id="draft-instruction"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. the /auth endpoint needs a token-bucket rate limiter"
                rows={3}
              />
            </Field>

            <Button
              type="button"
              variant="secondary"
              onClick={runDraft}
              disabled={!instruction.trim() || !agentId || drafting}
            >
              {drafting ? (
                <Loader2Icon data-icon="inline-start" className="animate-spin" />
              ) : (
                <BotIcon data-icon="inline-start" />
              )}
              {drafting ? "Drafting…" : "Draft card"}
            </Button>
          </FieldGroup>
        )}

        <form onSubmit={submit} className="flex flex-col gap-0">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ticket-title">Title</FieldLabel>
              <Input
                id="ticket-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs doing?"
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="ticket-body">Body</FieldLabel>
              <Textarea
                id="ticket-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Optional detail…"
                rows={5}
              />
              <FieldDescription>
                {draftedBy
                  ? `Drafted by ${draftedBy} — edit freely before creating.`
                  : "Everything here is read by the agent that picks this up."}
              </FieldDescription>
            </Field>
          </FieldGroup>

          <Separator className="my-4" />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || saving}>
              {isEdit ? "Save changes" : prompted ? "Create and dispatch" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
