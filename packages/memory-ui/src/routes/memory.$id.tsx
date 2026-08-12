import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { api, isLoggedIn, type MemoryEntry } from "~/lib/api";

export const Route = createFileRoute("/memory/$id")({
  component: MemoryDetailComponent,
});

function MemoryDetailComponent() {
  const { id } = useParams({ from: "/memory/$id" });
  const navigate = useNavigate();
  const [memory, setMemory] = useState<MemoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn] = useState(() => isLoggedIn());

  const loadMemory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entry = await api.get(id);
      setMemory(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (loggedIn) loadMemory();
  }, [loadMemory, loggedIn]);

  const handleDelete = async () => {
    if (!memory) return;
    if (!confirm(`Delete this memory?`)) return;
    try {
      await api.delete(memory.id);
      navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  if (!loggedIn) {
    return (
      <div className="login-prompt">
        <p>Please sign in to view memories.</p>
        <a href="/auth/sso?ui=1" className="btn btn-primary">Sign in</a>
      </div>
    );
  }

  if (loading) return <div className="loading">Loading…</div>;
  if (error && !memory) return <div className="error">{error}</div>;
  if (!memory) return <div className="empty">Memory not found.</div>;

  return (
    <div className="memory-detail">
      <div className="memory-detail-header">
        <h2>{memory.summary}</h2>
        <span className={`memory-type type-${memory.type}`}>
          {memory.type}
        </span>
      </div>

      <div className="memory-detail-content">
        <pre>{memory.content}</pre>
      </div>

      <div className="memory-detail-meta">
        <div><strong>ID:</strong> {memory.id}</div>
        <div><strong>Session:</strong> {memory.sessionId ?? "—"}</div>
        <div><strong>Created:</strong> {new Date(memory.createdAt).toLocaleString()}</div>
        <div><strong>Updated:</strong> {new Date(memory.updatedAt).toLocaleString()}</div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="memory-detail-actions">
        <button className="btn btn-danger" onClick={handleDelete}>
          Delete Memory
        </button>
      </div>
    </div>
  );
}
