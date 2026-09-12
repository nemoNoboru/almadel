import { useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Header } from "@/components/layout/Header"
import { Roster } from "@/components/roster/Roster"
import { Board } from "@/components/board/Board"
import { ConversationPanel } from "@/components/conversation/ConversationPanel"
import { AgentChatPanel } from "@/components/conversation/AgentChatPanel"
import { useApp } from "@/state/AppProvider"

export function BoardPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const { projects, selectedProjectId, selectedAgentId, rosterCollapsed, chatCollapsed, selectProject } = useApp()

  // Keep the URL and the selected project in sync.
  useEffect(() => {
    if (projectId && projectId !== selectedProjectId) {
      selectProject(projectId)
    }
  }, [projectId, selectedProjectId, selectProject])

  // Bare /p with no project in the URL → redirect to the current project.
  useEffect(() => {
    if (!projectId && selectedProjectId) {
      navigate(`/p/${selectedProjectId}`, { replace: true })
    } else if (!projectId && !selectedProjectId && projects.length === 0) {
      // No projects at all — nothing to select; the board shows an empty state.
    }
  }, [projectId, selectedProjectId, projects.length, navigate])

  return (
    <div className="flex h-dvh flex-col bg-background">
      <Header />
      <div className="flex min-h-0 flex-1">
        {!rosterCollapsed && <Roster />}
        <Board />
        {!chatCollapsed && (selectedAgentId ? <AgentChatPanel /> : <ConversationPanel />)}
      </div>
    </div>
  )
}
