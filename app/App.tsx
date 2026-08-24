import { Navigate, Route, Routes } from "react-router";
import { LilyEditor } from "./LilyEditor";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/editor" replace />} />
      <Route path="/editor" element={<LilyEditor />} />
      <Route path="*" element={<Navigate to="/editor" replace />} />
    </Routes>
  );
}
