import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { api, ApiError, type MemoryEntry } from "~/lib/api";
import { useAuthSession } from "~/lib/use-auth-session";

export const Route = createFileRoute("/memory/$id")({
  head: () => ({ meta: [{ title: "Memory details — Allen Labs" }] }),
  component: MemoryDetailComponent,
});

function MemoryDetailComponent() {
  const { id } = useParams({ from: "/memory/$id" });
  const navigate = useNavigate();
  const [memory, setMemory] = useState<MemoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
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
          setError(err instanceof Error ? err : new Error("Failed to load"));
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
  }, [id, loadRevision, loggedIn]);

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
        setError(err instanceof Error ? err : new Error("Delete failed"));
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
  if ((error instanceof ApiError && error.status === 404) || (!error && !memory)) {
    return (
      <section className="status-page" aria-labelledby="memory-not-found-title">
        <h1 id="memory-not-found-title">Memory not found</h1>
        <p>This memory may have been deleted or the link may be incorrect.</p>
        <div className="status-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setLoadRevision((value) => value + 1)}
          >
            Try again
          </button>
          <Link to="/" className="btn btn-primary">Go to memories</Link>
        </div>
      </section>
    );
  }
  if (error && !memory) {
    return (
      <section className="status-page" aria-labelledby="memory-error-title">
        <h1 id="memory-error-title">Memory could not load</h1>
        <p role="alert">{error.message}</p>
        <div className="status-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setLoadRevision((value) => value + 1)}
          >
            Try again
          </button>
          <Link to="/" className="btn btn-secondary">Go to memories</Link>
        </div>
      </section>
    );
  }
  if (!memory) return null;

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

      {error && <div className="error" role="alert">{error.message}</div>}

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
