import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  api,
  isLoggedIn,
  type MemoryListItem,
  type MemoryType,
  type StatsResponse,
  type SearchResponse,
} from "~/lib/api";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

const TYPE_COLORS: Record<MemoryType, string> = {
  fact: "type-fact",
  event: "type-event",
  instruction: "type-instruction",
  task: "type-task",
};

function HomeComponent() {
  const [memories, setMemories] = useState<MemoryListItem[]>([]);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn] = useState(() => isLoggedIn());
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [typeFilter, setTypeFilter] = useState<MemoryType | "">("");

  const loadMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.list({
        limit: 100,
        type: typeFilter || undefined,
      });
      setMemories(data.memories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSearchResult(null);
      loadMemories();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.search(q);
      setSearchResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [loadMemories]);

  useEffect(() => {
    if (!loggedIn) return;
    api.stats().then(setStats).catch(() => {});
  }, [loggedIn]);

  useEffect(() => {
    if (loggedIn) loadMemories();
  }, [loggedIn, loadMemories]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (loggedIn) doSearch(query);
    }, 400);
    return () => clearTimeout(timer);
  }, [query, loggedIn, doSearch]);

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete this memory?`)) return;
    try {
      await api.delete(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
      api.stats().then(setStats).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const types = useMemo(
    () =>
      (Object.entries(stats?.byType ?? {}) as [MemoryType, number][]).sort(
        (a, b) => b[1] - a[1],
      ),
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

  const displayItems = searchResult
    ? searchResult.candidates.map((c) => ({
        id: c.id,
        type: null as MemoryType | null,
        summary: c.summary,
        sessionId: c.sessionId,
        createdAt: "",
        updatedAt: "",
      }))
    : memories;

  return (
    <div>
      {stats && (
        <div className="stats-bar">
          <span className="stats-total">{stats.total} memories</span>
          <div className="type-chips">
            <button
              className={`chip ${typeFilter === "" ? "chip-active" : ""}`}
              onClick={() => setTypeFilter("")}
            >
              All
            </button>
            {types.map(([t, count]) => (
              <button
                key={t}
                className={`chip ${typeFilter === t ? "chip-active" : ""} ${TYPE_COLORS[t]}`}
                onClick={() => setTypeFilter(t)}
              >
                {t} ({count})
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

      {searchResult && searchResult.answer && (
        <div className="search-answer">
          <strong>Answer:</strong> {searchResult.answer}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {loading && <div className="loading">Loading…</div>}

      {!loading && displayItems.length === 0 && (
        <div className="empty">
          {query ? "No memories found." : "No memories yet. Create one!"}
        </div>
      )}

      <div className="memory-list">
        {displayItems.map((m) => (
          <div key={m.id} className="memory-card">
            <div className="memory-card-header">
              <Link
                to="/memory/$key"
                params={{ key: m.id }}
                className="memory-key"
              >
                {m.summary}
              </Link>
              <span className={`memory-type ${m.type ? TYPE_COLORS[m.type] ?? "" : ""}`}>
                {m.type ?? "search"}
              </span>
            </div>
            {m.createdAt && (
              <div className="memory-date">
                {new Date(m.createdAt).toLocaleDateString()}
              </div>
            )}
            <div className="memory-card-footer">
              {m.sessionId && (
                <span className="tag">session: {m.sessionId}</span>
              )}
              <button
                className="btn btn-danger btn-sm"
                onClick={() => handleDelete(m.id)}
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
