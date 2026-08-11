import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, isLoggedIn } from "~/lib/api";

export const Route = createFileRoute("/new")({
  component: NewMemoryComponent,
});

function NewMemoryComponent() {
  const navigate = useNavigate();
  const [content, setContent] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn] = useState(() => isLoggedIn());

  if (!loggedIn) {
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
      await api.add({
        content: content.trim(),
        sessionId: sessionId.trim() || undefined,
      });
      navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create memory");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="form-page">
      <h2>New Memory</h2>
      <p className="form-hint">
        Agent Memory will automatically classify this as a fact, event,
        instruction, or task, and generate a summary.
      </p>
      <form onSubmit={handleSubmit}>
        <div className="form-field">
          <label htmlFor="content">Content</label>
          <textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="What do you want to remember?"
            rows={6}
            required
            autoFocus
          />
        </div>
        <div className="form-field">
          <label htmlFor="sessionId">Session ID (optional)</label>
          <input
            id="sessionId"
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Group related memories by session"
          />
        </div>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? "Saving…" : "Save Memory"}
        </button>
      </form>
    </div>
  );
}
