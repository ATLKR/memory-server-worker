import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo } from "react";
import { api, isLoggedIn, type MemoryEntry, type StatsResponse } from "~/lib/api";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const navigate = useNavigate();
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Initialize synchronously to avoid flash of login prompt.
  const [loggedIn] = useState(() => isLoggedIn());
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [namespaceFilter, setNamespaceFilter] = useState<string>("");

  const loadMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.list({
        limit: 100,
        namespace: namespaceFilter || undefined,
      });
      setMemories(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [namespaceFilter]);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      loadMemories();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.search(q, {
        limit: 50,
        namespace: namespaceFilter || undefined,
      });
      setMemories(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [loadMemories, namespaceFilter]);

  // Load stats on mount.
  useEffect(() => {
    if (!loggedIn) return;
    api.stats().then(setStats).catch(() => {});
  }, [loggedIn]);

  // Load memories on mount / namespace change.
  useEffect(() => {
    if (loggedIn) loadMemories();
  }, [loggedIn, loadMemories]);

  // Debounced search.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (loggedIn) doSearch(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, loggedIn, doSearch]);

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete "${key}"?`)) return;
    try {
      await api.delete(key);
      setMemories((prev) => prev.filter((m) => m.key !== key));
      // Refresh stats after delete.
      api.stats().then(setStats).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const namespaces = useMemo(
    () => Object.entries(stats?.byNamespace ?? {}).sort((a, b) => b[1] - a[1]),
    [stats],
  );

  if (!loggedIn) {
    return (
      <div className="login-prompt">
        <h2>Memory</h2>
        <p>Personal persistent memory across AI agents.</p>
        <a href="/auth/sso?ui=1" className="btn btn-primary">
          Sign in with Allen Labs SSO
        </a>
      </div>
    );
  }

  return (
    <div>
      {/* Stats bar */}
      {stats && (
        <div className="stats-bar">
          <span className="stats-total">{stats.total} memories</span>
          <div className="namespace-chips">
            <button
              className={`chip ${namespaceFilter === "" ? "chip-active" : ""}`}
              onClick={() => setNamespaceFilter("")}
            >
              All
            </button>
            {namespaces.map(([ns, count]) => (
              <button
                key={ns}
                className={`chip ${namespaceFilter === ns ? "chip-active" : ""}`}
                onClick={() => setNamespaceFilter(ns)}
              >
                {ns} ({count})
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="search-bar">
        <input
          type="text"
          placeholder="Search memories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="search-input"
          autoFocus
        />
        <Link to="/new" className="btn btn-primary">
          + New
        </Link>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="loading">Loading…</div>}

      {!loading && memories.length === 0 && (
        <div className="empty">
          {query ? "No memories found." : "No memories yet. Create one!"}
        </div>
      )}

      <div className="memory-list">
        {memories.map((m) => (
          <div key={m.id} className="memory-card">
            <div className="memory-card-header">
              <Link
                to="/memory/$key"
                params={{ key: m.key ?? m.id }}
                className="memory-key"
              >
                {m.key ?? m.id}
              </Link>
              <span className="memory-namespace">{m.namespace}</span>
            </div>
            <div className="memory-content">{m.content}</div>
            <div className="memory-card-footer">
              {m.tags.map((t) => (
                <span key={t} className="tag">{t}</span>
              ))}
              <span className="memory-date">
                {new Date(m.updatedAt).toLocaleDateString()}
              </span>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => m.key && handleDelete(m.key)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
