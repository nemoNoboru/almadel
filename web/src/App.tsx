import { Navigate, Route, Routes } from "react-router-dom"
import { BoardPage } from "@/pages/BoardPage"
import { JoinPage } from "@/pages/JoinPage"

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/p" replace />} />
      <Route path="/p" element={<BoardPage />} />
      <Route path="/p/:projectId" element={<BoardPage />} />
      <Route path="/join" element={<JoinPage />} />
      <Route path="*" element={<Navigate to="/p" replace />} />
    </Routes>
  )
}
