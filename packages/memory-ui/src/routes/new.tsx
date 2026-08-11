import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, isLoggedIn } from "~/lib/api";

export const Route = createFileRoute("/new")({
  component: NewMemoryComponent,
});

function NewMemoryComponent() {
  const navigate = useNavigate();
  const [content, setContent] = useState("");
  const [key, setKey] = useState("");
  const [namespace, setNamespace] = useState("facts");
  const [tags, setTags] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isLoggedIn()) {
    return (
      <div className="login-prompt">
        <p>Please sign in to create memories.</p>
        <a href="/auth/sso?ui=1" className="btn btn-primary">Sign in</a>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const entry = await api.add({
        content,
        key: key.trim() || undefined,
        namespace: namespace.trim() || undefined,
        tags: tagList,
      });
      navigate({ to: "/memory/$key", params: { key: entry.key ?? entry.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="form-page">
      <h2>New Memory</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-field">
          <label htmlFor="key">Key (optional)</label>
          <input
            id="key"
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="my-memory-key"
          />
        </div>
        <div className="form-field">
          <label htmlFor="namespace">Namespace</label>
          <select
            id="namespace"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          >
            <option value="facts">facts</option>
            <option value="preferences">preferences</option>
            <option value="projects">projects</option>
            <option value="decisions">decisions</option>
            <option value="conversations">conversations</option>
            <option value="default">default</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="tags">Tags (comma-separated)</label>
          <input
            id="tags"
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="typescript, cloudflare, important"
          />
        </div>
        <div className="form-field">
          <label htmlFor="content">Content</label>
          <textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            placeholder="Write your memory here…"
            required
          />
        </div>
        {error && <div className="error">{error}</div>}
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate({ to: "/" })}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading || !content.trim()}
          >
            {loading ? "Saving…" : "Save Memory"}
          </button>
        </div>
      </form>
    </div>
  );
}
