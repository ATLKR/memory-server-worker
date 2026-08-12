import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { api, isLoggedIn, type SummaryResponse } from "~/lib/api";

export const Route = createFileRoute("/summary")({
  component: SummaryComponent,
});

function SummaryComponent() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn] = useState(() => isLoggedIn());

  useEffect(() => {
    if (!loggedIn) return;
    api
      .summary()
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load summary"))
      .finally(() => setLoading(false));
  }, [loggedIn]);

  if (!loggedIn) {
    return (
      <div className="login-prompt">
        <p>Please sign in to view your memory summary.</p>
        <a href="/auth/sso?ui=1" className="btn btn-primary">Sign in</a>
      </div>
    );
  }

  return (
    <div className="memory-detail">
      <div className="memory-detail-header">
        <h2>Memory Summary</h2>
        <Link to="/" className="btn btn-secondary">← Back</Link>
      </div>

      {loading && <div className="loading">Loading…</div>}
      {error && <div className="error">{error}</div>}
      {summary && (
        <div className="memory-detail-content">
          <pre>{summary.summary}</pre>
        </div>
      )}
    </div>
  );
}
