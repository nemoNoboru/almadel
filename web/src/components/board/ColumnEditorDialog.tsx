import { useEffect, useMemo, useState } from "react"
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, TrashIcon } from "lucide-react"
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
import { ScrollArea } from "@/components/ui/scroll-area"
import { useApp } from "@/state/AppProvider"
import type { Column } from "@/types/domain"

type Target = Column | "pipeline"

interface Draft {
  id: string
  name: string
  prompt: string
  next_column: string
  fail_column: string
  wip_limit: string
}

const SAMPLE = {
  id: "TCK-412",
  title: "Add rate limiting",
  body: "Token-bucket limiter for /auth",
  branch: "run/TCK-412",
  project: "almadel-api",
  port_base: "8100",
  thread: "… full comment history …",
}

function renderPrompt(prompt: string): string {
  return prompt
    .replaceAll("{{ticket.id}}", SAMPLE.id)
    .replaceAll("{{ticket.title}}", SAMPLE.title)
    .replaceAll("{{ticket.body}}", SAMPLE.body)
    .replaceAll("{{branch}}", SAMPLE.branch)
    .replaceAll("{{project}}", SAMPLE.project)
    .replaceAll("{{port_base}}", SAMPLE.port_base)
    .replaceAll("{{thread}}", SAMPLE.thread)
}

function toDraft(c: Column): Draft {
  return {
    id: c.id,
    name: c.name,
    prompt: c.prompt ?? "",
    next_column: c.next_column ?? "",
    fail_column: c.fail_column ?? "",
    wip_limit: c.wip_limit?.toString() ?? "",
  }
}

export function ColumnEditorDialog({
  open,
  target,
  onOpenChange,
}: {
  open: boolean
  target: Target | null
  onOpenChange: (open: boolean) => void
}) {
  const { board, updateColumns } = useApp()
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !board || !target) return
    if (target === "pipeline") {
      setDrafts(board.columns.map(toDraft))
      setFocusedId(null)
    } else {
      setDrafts(board.columns.map(toDraft))
      setFocusedId(target.id)
    }
  }, [open, board, target])

  const siblings = useMemo(() => {
    return drafts
      .map((d) => ({ value: d.name, label: d.name }))
      .concat([{ value: "none", label: "— none —" }])
  }, [drafts])

  if (!board) return null

  const updateDraft = (id: string, changes: Partial<Draft>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...changes } : d)),
    )
  }

  const move = (index: number, dir: -1 | 1) => {
    setDrafts((prev) => {
      const next = [...prev]
      const j = index + dir
      if (j < 0 || j >= next.length) return prev
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  const remove = (id: string) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id))
  }

  const add = () => {
    const draft: Draft = {
      id: `new-${Date.now()}`,
      name: "",
      prompt: "",
      next_column: "",
      fail_column: "",
      wip_limit: "",
    }
    setDrafts((prev) => [...prev, draft])
    setFocusedId(draft.id)
  }

  const save = async () => {
    if (!board) return
    setSaving(true)
    try {
      await updateColumns(
        board.project.id,
        drafts.map((d, i) => ({
          id: d.id.startsWith("new-") ? undefined : d.id,
          name: d.name || `Column ${i + 1}`,
          prompt: d.prompt.trim() || null,
          next_column: d.next_column || null,
          fail_column: d.fail_column || null,
          wip_limit: d.wip_limit ? Number(d.wip_limit) : null,
        })) as Column[],
      )
      toast.success("Pipeline updated")
      onOpenChange(false)
    } catch {
      toast.error("Couldn't save the pipeline")
    } finally {
      setSaving(false)
    }
  }

  const visibleDrafts =
    target === "pipeline" || !focusedId
      ? drafts
      : drafts.filter((d) => d.id === focusedId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target === "pipeline" ? "Edit pipeline" : "Edit column"}
          </DialogTitle>
          <DialogDescription>
            Columns are the workflow. A column with a prompt is an agent stage; an
            empty prompt is a human gate.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <FieldGroup className="px-0.5 py-0.5">
            {visibleDrafts.map((draft, i) => (
              <ColumnFields
                key={draft.id}
                draft={draft}
                index={i}
                total={drafts.length}
                siblings={siblings}
                showReorder={target === "pipeline"}
                onChange={(changes) => updateDraft(draft.id, changes)}
                onMove={move}
                onRemove={remove}
              />
            ))}
          </FieldGroup>
        </ScrollArea>

        {target === "pipeline" && (
          <Button variant="outline" size="sm" onClick={add} className="w-fit">
            <PlusIcon data-icon="inline-start" />
            Add column
          </Button>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || drafts.length === 0}>
            Save pipeline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ColumnFields({
  draft,
  index,
  total,
  siblings,
  showReorder,
  onChange,
  onMove,
  onRemove,
}: {
  draft: Draft
  index: number
  total: number
  siblings: { value: string; label: string }[]
  showReorder: boolean
  onChange: (patch: Partial<Draft>) => void
  onMove: (index: number, dir: -1 | 1) => void
  onRemove: (id: string) => void
}) {
  const [preview, setPreview] = useState(false)
  const isGate = draft.prompt.trim() === ""

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        {showReorder && (
          <div className="flex flex-col">
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={index === 0}
              aria-label="Move up"
              onClick={() => onMove(index, -1)}
            >
              <ChevronUpIcon data-icon="inline-start" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={index === total - 1}
              aria-label="Move down"
              onClick={() => onMove(index, 1)}
            >
              <ChevronDownIcon data-icon="inline-start" />
            </Button>
          </div>
        )}

        <Field className="flex-1">
          <FieldLabel htmlFor={`name-${draft.id}`}>Name</FieldLabel>
          <Input
            id={`name-${draft.id}`}
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Planning"
          />
        </Field>

        {showReorder && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove column"
            onClick={() => onRemove(draft.id)}
          >
            <TrashIcon data-icon="inline-start" />
          </Button>
        )}
      </div>

      <Field>
        <FieldLabel htmlFor={`prompt-${draft.id}`}>
          Prompt {isGate && <span className="text-muted-foreground">(manual gate)</span>}
        </FieldLabel>
        <Textarea
          id={`prompt-${draft.id}`}
          value={draft.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          rows={4}
          className="font-mono text-xs"
          placeholder="Leave empty for a manual gate — nothing auto-dispatches."
        />
        <FieldDescription>
          Variables: {"{{ticket.id}}"} {"{{ticket.title}}"} {"{{ticket.body}}"} {"{{thread}}"} {"{{branch}}"} {"{{project}}"} {"{{port_base}}"}
        </FieldDescription>
        {!isGate && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-6 px-0"
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? "Hide preview" : "Preview rendered prompt"}
          </Button>
        )}
        {!isGate && preview && (
          <pre className="whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground">
            {renderPrompt(draft.prompt)}
          </pre>
        )}
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <Field>
          <FieldLabel htmlFor={`next-${draft.id}`}>Next</FieldLabel>
          <Select
            value={draft.next_column || "none"}
            onValueChange={(v) => onChange({ next_column: v === "none" ? "" : v })}
          >
            <SelectTrigger id={`next-${draft.id}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {siblings.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor={`fail-${draft.id}`}>On failure</FieldLabel>
          <Select
            value={draft.fail_column || "none"}
            onValueChange={(v) => onChange({ fail_column: v === "none" ? "" : v })}
          >
            <SelectTrigger id={`fail-${draft.id}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {siblings.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor={`wip-${draft.id}`}>WIP limit</FieldLabel>
          <Input
            id={`wip-${draft.id}`}
            type="number"
            min={0}
            value={draft.wip_limit}
            onChange={(e) => onChange({ wip_limit: e.target.value })}
            placeholder="∞"
          />
        </Field>
      </div>

      {showReorder && index < total - 1 && <Separator className="mt-1" />}
    </div>
  )
}
