import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { useApp } from "@/state/AppProvider"

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { createProject } = useApp()
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [gitRemote, setGitRemote] = useState("")
  const [defaultBranch, setDefaultBranch] = useState("main")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName("")
      setGitRemote("")
      setDefaultBranch("main")
    }
  }, [open])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      const project = await createProject({
        name: name.trim(),
        git_remote: gitRemote.trim() || null,
        default_branch: defaultBranch.trim() || "main",
      })
      toast.success(`Created ${name.trim()}`)
      onOpenChange(false)
      navigate(`/p/${project.id}`)
    } catch {
      toast.error("Couldn't create the project")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project gets a default board, ready for agents to join and clone its repository.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="project-name">Name</FieldLabel>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                autoFocus
              />
              <FieldDescription>
                Lowercase slug. Agents join with ALMADEL_JOIN=this name.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="project-remote">Origin URL</FieldLabel>
              <Input
                id="project-remote"
                value={gitRemote}
                onChange={(e) => setGitRemote(e.target.value)}
                placeholder="git@github.com:me/my-project.git"
              />
              <FieldDescription>
                Optional. Agents must match this remote when they register, so they can clone it next.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="project-branch">Default branch</FieldLabel>
              <Input
                id="project-branch"
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                placeholder="main"
              />
            </Field>
          </FieldGroup>

          <DialogFooter className="mt-5">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
