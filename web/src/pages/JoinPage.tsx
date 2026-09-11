import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CheckIcon, CopyIcon, FlameIcon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useApp } from "@/state/AppProvider"
import { toast } from "sonner"

export function JoinPage() {
  const [params] = useSearchParams()
  const token = params.get("t") ?? ""
  const { roster, selectProject } = useApp()
  const [copied, setCopied] = useState(false)
  const [showUnattended, setShowUnattended] = useState(false)

  const origin = window.location.origin

  const projectId = params.get("project") ?? ""
  const project = useMemo(
    () => roster?.projects.find((p) => p.project.id === projectId),
    [roster, projectId],
  )

  const joinedAgents = useMemo(
    () => project?.agents.filter((a) => a.online) ?? [],
    [project],
  )

  useEffect(() => {
    if (projectId) selectProject(projectId)
  }, [projectId, selectProject])

  const copyToken = async () => {
    await navigator.clipboard.writeText(token)
    setCopied(true)
    toast.success("Token copied")
    setTimeout(() => setCopied(false), 2000)
  }

  const copyCommand = async () => {
    await navigator.clipboard.writeText(
      `/almadel join ${origin} --token ${token}`,
    )
    toast.success("Command copied")
  }

  const joined = joinedAgents.length > 0

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <div className="flex items-center gap-2">
          <FlameIcon className="size-5 text-warning" />
          <h1 className="font-heading text-lg font-semibold tracking-tight">
            Join Almadel
          </h1>
        </div>

        {!token && (
          <Card>
            <CardHeader>
              <CardTitle>Missing token</CardTitle>
              <CardDescription>
                Join links carry a per-project token: <code>/join?t=&lt;token&gt;</code>.
                Ask whoever runs the board for a fresh link.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {token && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>1. Install the plugin</CardTitle>
                <CardDescription>
                  This only puts code on your machine — it does not connect to
                  anything yet.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <code className="rounded-lg bg-muted px-3 py-2 font-mono text-sm">
                  bunx @almadel/opencode-plugin init
                </code>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>2. Restart opencode, then join</CardTitle>
                <CardDescription>
                  Restarting loads the plugin. The token goes on the command — not in
                  a file — because <code>opencode.json</code> is committed.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-lg bg-muted px-3 py-2 font-mono text-sm">
                    /almadel join {origin} --token {token}
                  </code>
                  <Button variant="outline" size="icon" onClick={copyCommand}>
                    <CopyIcon data-icon="inline-start" />
                  </Button>
                </div>

                <Button variant="outline" size="sm" onClick={copyToken} className="w-fit">
                  {copied ? (
                    <CheckIcon data-icon="inline-start" />
                  ) : (
                    <CopyIcon data-icon="inline-start" />
                  )}
                  {copied ? "Copied" : "Copy token — shown once"}
                </Button>

                {project && (
                  <p className="text-xs text-muted-foreground">
                    This agent will be bound to{" "}
                    <span className="font-medium text-foreground">
                      {project.project.name}
                    </span>
                    .
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                {joined ? (
                  <>
                    <span className="flex size-6 items-center justify-center rounded-full bg-success/15 text-success-foreground dark:text-success">
                      <CheckIcon className="size-4" />
                    </span>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">
                        {joinedAgents[0].name ?? "An agent"} joined
                      </span>
                      <span className="text-xs text-muted-foreground">
                        The slot is live and ready to claim work.
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">
                      Waiting for an agent to join…
                    </span>
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <div>
          <Button
            variant="link"
            size="sm"
            className="px-0"
            onClick={() => setShowUnattended((s) => !s)}
          >
            {showUnattended ? "Hide" : "Show"} unattended worker setup
          </Button>
          {showUnattended && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Unattended worker</CardTitle>
                <CardDescription>
                  For a dedicated machine, express join intent through the
                  environment instead of a command.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">
                  {`# /etc/systemd/system/almadel-agent@.service
Environment=ALMADEL_JOIN=${origin}
EnvironmentFile=/etc/almadel/token   # ALMADEL_TOKEN=...
WorkingDirectory=/srv/slots/%i
Restart=always`}
                </pre>
              </CardContent>
            </Card>
          )}
        </div>

        <Separator />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">read-only documentation</Badge>
          No server round-trip: the tick is a re-check of the roster.
        </div>
      </div>
    </div>
  )
}
