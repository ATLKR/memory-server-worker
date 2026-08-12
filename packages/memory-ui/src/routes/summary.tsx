import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { api, type SummaryResponse } from "~/lib/api";
import { useAuthSession } from "~/lib/use-auth-session";

export const Route = createFileRoute("/summary")({
  head: () => ({ meta: [{ title: "Memory summary — Allen Labs" }] }),
  component: SummaryComponent,
});

function SummaryComponent() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const { ready, loggedIn } = useAuthSession();
  const requestGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++requestGeneration.current;

    if (!loggedIn) {
      controller.abort();
      return;
    }

    setLoading(true);
    setError(null);
    setSummary(null);

    void api
      .summary(undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          setSummary(result);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          setError(err instanceof Error ? err.message : "Failed to load summary");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
      if (generation === requestGeneration.current) requestGeneration.current += 1;
    };
  }, [loggedIn, revision]);

  if (!ready) return <div className="loading" role="status">Checking session…</div>;

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
        <h1>Memory Summary</h1>
        <Link to="/" className="btn btn-secondary">← Back</Link>
      </div>

      {loading && <div className="loading" role="status">Loading…</div>}
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      )}
      {summary && (
        <div className="memory-detail-content">
          <pre>{summary.summary}</pre>
        </div>
      )}
    </div>
  );
}
