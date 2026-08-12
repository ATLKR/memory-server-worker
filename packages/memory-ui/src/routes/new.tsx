import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "~/lib/api";
import { useAuthSession } from "~/lib/use-auth-session";

const MAX_CONTENT_BYTES = 32 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const Route = createFileRoute("/new")({
  component: NewMemoryComponent,
});

function NewMemoryComponent() {
  const navigate = useNavigate();
  const [content, setContent] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ready, loggedIn } = useAuthSession();
  const contentBytes = utf8ByteLength(content.trim());
  const contentTooLarge = contentBytes > MAX_CONTENT_BYTES;

  if (!ready) {
    return <div className="loading" role="status">Checking session…</div>;
  }

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
    const trimmedContent = content.trim();
    if (!trimmedContent) return;
    if (utf8ByteLength(trimmedContent) > MAX_CONTENT_BYTES) {
      setError("Content exceeds the 32 KiB UTF-8 limit.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.add({
        content: trimmedContent,
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
      <h1>New Memory</h1>
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
            maxLength={32768}
            aria-describedby="content-byte-limit"
            aria-invalid={contentTooLarge}
            required
            autoFocus
          />
          <p id="content-byte-limit" className="form-hint">
            {contentBytes.toLocaleString()} / {MAX_CONTENT_BYTES.toLocaleString()} UTF-8 bytes
          </p>
        </div>
        <div className="form-field">
          <label htmlFor="sessionId">Session ID (optional)</label>
          <input
            id="sessionId"
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Group related memories by session"
            maxLength={64}
          />
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={loading || contentTooLarge}
        >
          {loading ? "Saving…" : "Save Memory"}
        </button>
      </form>
    </div>
  );
}
