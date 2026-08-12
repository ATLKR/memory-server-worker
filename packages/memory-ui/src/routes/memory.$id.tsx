import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { api, type MemoryEntry } from "~/lib/api";
import { useAuthSession } from "~/lib/use-auth-session";

export const Route = createFileRoute("/memory/$id")({
  component: MemoryDetailComponent,
});

function MemoryDetailComponent() {
  const { id } = useParams({ from: "/memory/$id" });
  const navigate = useNavigate();
  const [memory, setMemory] = useState<MemoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ready, loggedIn } = useAuthSession();
  const loadGeneration = useRef(0);
  const deleteGeneration = useRef(0);
  const deleteAbortController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++loadGeneration.current;

    if (!loggedIn) {
      controller.abort();
      return;
    }

    setLoading(true);
    setError(null);
    setMemory(null);

    void (async () => {
      try {
        const entry = await api.get(id, controller.signal);
        if (!controller.signal.aborted && generation === loadGeneration.current) {
          setMemory(entry);
        }
      } catch (err) {
        if (!controller.signal.aborted && generation === loadGeneration.current) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!controller.signal.aborted && generation === loadGeneration.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
      if (generation === loadGeneration.current) loadGeneration.current += 1;
    };
  }, [id, loggedIn]);

  useEffect(() => {
    setDeleting(false);
    return () => {
      deleteGeneration.current += 1;
      deleteAbortController.current?.abort();
      deleteAbortController.current = null;
    };
  }, [id, loggedIn]);

  const handleDelete = async () => {
    if (!memory || deleting) return;
    if (!confirm(`Delete this memory?`)) return;
    deleteAbortController.current?.abort();
    const controller = new AbortController();
    deleteAbortController.current = controller;
    const generation = ++deleteGeneration.current;
    setDeleting(true);
    setError(null);
    try {
      await api.delete(memory.id, controller.signal);
      if (!controller.signal.aborted && generation === deleteGeneration.current) {
        void navigate({ to: "/" });
      }
    } catch (err) {
      if (!controller.signal.aborted && generation === deleteGeneration.current) {
        setError(err instanceof Error ? err.message : "Delete failed");
      }
    } finally {
      if (generation === deleteGeneration.current) {
        deleteAbortController.current = null;
        if (!controller.signal.aborted) setDeleting(false);
      }
    }
  };

  if (!ready) return <div className="loading" role="status">Checking session…</div>;

  if (!loggedIn) {
    return (
      <div className="login-prompt">
        <p>Please sign in to view memories.</p>
        <a href="/auth/sso?ui=1" className="btn btn-primary">Sign in</a>
      </div>
    );
  }

  if (loading) return <div className="loading" role="status">Loading…</div>;
  if (error && !memory) return <div className="error" role="alert">{error}</div>;
  if (!memory) return <div className="empty">Memory not found.</div>;

  return (
    <div className="memory-detail">
      <div className="memory-detail-header">
        <h1>{memory.summary}</h1>
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

      {error && <div className="error" role="alert">{error}</div>}

      <div className="memory-detail-actions">
        <button
          type="button"
          className="btn btn-danger"
          onClick={handleDelete}
          disabled={deleting}
          aria-busy={deleting}
        >
          {deleting ? "Deleting…" : "Delete Memory"}
        </button>
      </div>
    </div>
  );
}
