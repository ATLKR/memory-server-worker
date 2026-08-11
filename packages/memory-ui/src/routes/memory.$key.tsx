import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { api, isLoggedIn, type MemoryEntry } from "~/lib/api";

export const Route = createFileRoute("/memory/$key")({
  component: MemoryDetailComponent,
});

function MemoryDetailComponent() {
  const { key } = Route.useParams();
  const navigate = useNavigate();
  const [memory, setMemory] = useState<MemoryEntry | null>(null);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn] = useState(() => isLoggedIn());

  const loadMemory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entry = await api.get(key);
      setMemory(entry);
      setContent(entry.content);
      setTags(entry.tags.join(", "));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (loggedIn) loadMemory();
  }, [loadMemory, loggedIn]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memory) return;
    setSaving(true);
    setError(null);
    try {
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const updated = await api.update(key, {
        content,
        tags: tagList,
      });
      setMemory(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete "${key}"?`)) return;
    try {
      await api.delete(key);
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
    <div className="detail-page">
      <div className="detail-header">
        <h2>{memory.key ?? memory.id}</h2>
        <div className="detail-meta">
          <span className="memory-namespace">{memory.namespace}</span>
          <span className="memory-date">
            Updated: {new Date(memory.updatedAt).toLocaleString()}
          </span>
          <span className="memory-date">
            Created: {new Date(memory.createdAt).toLocaleString()}
          </span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {editing ? (
        <form onSubmit={handleSave}>
          <div className="form-field">
            <label htmlFor="tags">Tags (comma-separated)</label>
            <input
              id="tags"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="content">Content</label>
            <textarea
              id="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={15}
            />
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setEditing(false);
                setContent(memory.content);
                setTags(memory.tags.join(", "));
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      ) : (
        <div>
          <div className="detail-content">
            <pre>{memory.content}</pre>
          </div>
          <div className="detail-tags">
            {memory.tags.map((t) => (
              <span key={t} className="tag">{t}</span>
            ))}
          </div>
          {Object.keys(memory.metadata).length > 0 && (
            <div className="detail-metadata">
              <h3>Metadata</h3>
              <pre>{JSON.stringify(memory.metadata, null, 2)}</pre>
            </div>
          )}
          <div className="form-actions">
            <button
              className="btn btn-secondary"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button className="btn btn-danger" onClick={handleDelete}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
