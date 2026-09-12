import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useTheme } from "next-themes"
import { MoonIcon, SunIcon, FlameIcon, PlusIcon, PanelLeftIcon, PanelRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { useApp } from "@/state/AppProvider"
import { isMock } from "@/api"
import { NewProjectDialog } from "@/components/layout/NewProjectDialog"

export function Header() {
  const { projects, selectedProjectId, roster, selectProject, rosterCollapsed, chatCollapsed, toggleRoster, toggleChat } =
    useApp()
  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useTheme()
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  const needsYou = roster?.needs_you ?? 0

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <div className="flex items-center gap-2 font-heading text-sm font-semibold tracking-tight">
        <FlameIcon className="size-4 text-warning" />
        Almadel
        {isMock && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            mock
          </Badge>
        )}
      </div>

      <Select
        value={selectedProjectId ?? undefined}
        onValueChange={(v) => {
          selectProject(v)
          navigate(`/p/${v}`)
        }}
      >
        <SelectTrigger className="w-52">
          <SelectValue placeholder="Select project" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <div className="flex-1" />

      <Button
        variant="outline"
        size="sm"
        onClick={() => setNewProjectOpen(true)}
      >
        <PlusIcon data-icon="inline-start" />
        New project
      </Button>

      {needsYou > 0 && (
        <Badge className="bg-warning/15 text-warning-foreground dark:text-warning">
          <FlameIcon className="size-3" data-icon="inline-start" />
          {needsYou} needs you
        </Badge>
      )}

      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle roster"
        aria-pressed={!rosterCollapsed}
        onClick={toggleRoster}
      >
        <PanelLeftIcon data-icon="inline-start" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle chat"
        aria-pressed={!chatCollapsed}
        onClick={toggleChat}
      >
        <PanelRightIcon data-icon="inline-start" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle theme"
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      >
        <SunIcon className="hidden dark:block" data-icon="inline-start" />
        <MoonIcon className="dark:hidden" data-icon="inline-start" />
      </Button>

      <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
    </header>
  )
}
