import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  api,
  type MemoryListItem,
  type MemoryType,
  type StatsResponse,
} from "~/lib/api";
import { useDebouncedSearch } from "~/lib/use-debounced-search";
import { useAuthSession } from "~/lib/use-auth-session";
import { MAX_SEARCH_QUERY_BYTES, utf8ByteLength } from "~/lib/validation";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Memories — Allen Labs" }] }),
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
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ready, loggedIn } = useAuthSession();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [typeFilter, setTypeFilter] = useState<MemoryType | "">("");
  const mountedRef = useRef(true);
  const queryRef = useRef(query);
  const typeFilterRef = useRef(typeFilter);
  const listRequestId = useRef(0);
  const listAbortController = useRef<AbortController | null>(null);
  const statsRequestId = useRef(0);
  const queryBytes = utf8ByteLength(query);
  const queryTooLarge = queryBytes > MAX_SEARCH_QUERY_BYTES;
  const {
    result: searchResult,
    searching,
    error: searchError,
    retry: retrySearch,
  } = useDebouncedSearch(query, loggedIn && !queryTooLarge);
  const loading = listLoading || searching;
  const visibleError = searchError ?? error;

  const invalidateListRequest = useCallback(() => {
    listRequestId.current += 1;
    listAbortController.current?.abort();
    listAbortController.current = null;
  }, []);

  const loadMemories = useCallback(async () => {
    listAbortController.current?.abort();
    const controller = new AbortController();
    listAbortController.current = controller;
    const requestId = ++listRequestId.current;
    const requestedType = typeFilter;
    setListLoading(true);
    setLoadingMore(false);
    setError(null);
    try {
      const data = await api.list({
        limit: 100,
        type: requestedType || undefined,
      }, controller.signal);
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestId === listRequestId.current &&
        requestedType === typeFilterRef.current &&
        !queryRef.current.trim()
      ) {
        setMemories(data.memories);
        setCursor(data.cursor);
      }
    } catch (err) {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestId === listRequestId.current
      ) {
        setError(err instanceof Error ? err.message : "Failed to load");
      }
    } finally {
      if (requestId === listRequestId.current) {
        listAbortController.current = null;
        if (mountedRef.current) setListLoading(false);
      }
    }
  }, [typeFilter]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading || loadingMore || queryRef.current.trim()) return;
    listAbortController.current?.abort();
    const controller = new AbortController();
    listAbortController.current = controller;
    const requestId = ++listRequestId.current;
    const requestedType = typeFilter;
    const requestedCursor = cursor;
    setLoadingMore(true);
    setError(null);
    try {
      const data = await api.list({
        limit: 100,
        type: requestedType || undefined,
        cursor: requestedCursor,
      }, controller.signal);
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestId === listRequestId.current &&
        requestedType === typeFilterRef.current &&
        !queryRef.current.trim()
      ) {
        setMemories((prev) => [...prev, ...data.memories]);
        setCursor(data.cursor);
      }
    } catch (err) {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestId === listRequestId.current
      ) {
        setError(err instanceof Error ? err.message : "Failed to load more");
      }
    } finally {
      if (requestId === listRequestId.current) {
        listAbortController.current = null;
        if (mountedRef.current) setLoadingMore(false);
      }
    }
  }, [cursor, loading, loadingMore, typeFilter]);

  const refreshStats = useCallback(async () => {
    const requestId = ++statsRequestId.current;
    try {
      const data = await api.stats();
      if (mountedRef.current && requestId === statsRequestId.current) {
        setStats(data);
      }
    } catch {
      // Stats are supplementary; keep the last successful value.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateListRequest();
      statsRequestId.current += 1;
    };
  }, [invalidateListRequest]);

  useEffect(() => {
    if (!loggedIn) return;
    void refreshStats();
  }, [loggedIn, refreshStats]);

  useEffect(() => {
    if (!loggedIn || query.trim()) {
      invalidateListRequest();
      setListLoading(false);
      setLoadingMore(false);
      return;
    }
    void loadMemories();
    return invalidateListRequest;
  }, [loggedIn, loadMemories, query, invalidateListRequest]);

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete this memory?`)) return;
    try {
      await api.delete(id);
      if (!mountedRef.current) return;
      setMemories((prev) => prev.filter((m) => m.id !== id));
      const currentQuery = queryRef.current;
      if (currentQuery.trim()) retrySearch();
      void refreshStats();
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Delete failed");
      }
    }
  };

  const types = useMemo(
    () =>
      (Object.entries(stats?.byType ?? {}) as [MemoryType, number][]).sort(
        (a, b) => b[1] - a[1],
      ),
    [stats],
  );

  if (!ready) {
    return <div className="loading" role="status">Checking session…</div>;
  }

  if (!loggedIn) {
    return (
      <div className="login-prompt">
        <h1>Memory</h1>
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
    <div aria-busy={loading || loadingMore}>
      <h1 className="sr-only">Memories</h1>
      {stats && (
        <div className="stats-bar">
          <span className="stats-total">
            {stats.total}{stats.truncated ? "+" : ""} memories
          </span>
          <div className="type-chips" role="group" aria-label="Filter memories by type">
            <button
              type="button"
              className={`chip ${typeFilter === "" ? "chip-active" : ""}`}
              onClick={() => {
                if (typeFilter === "") return;
                typeFilterRef.current = "";
                invalidateListRequest();
                setTypeFilter("");
              }}
              aria-pressed={typeFilter === ""}
            >
              All
            </button>
            {types.map(([t, count]) => (
              <button
                type="button"
                key={t}
                className={`chip ${typeFilter === t ? "chip-active" : ""} ${TYPE_COLORS[t]}`}
                onClick={() => {
                  if (typeFilter === t) return;
                  typeFilterRef.current = t;
                  invalidateListRequest();
                  setTypeFilter(t);
                }}
                aria-pressed={typeFilter === t}
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
          aria-label="Search memories"
          value={query}
          onChange={(e) => {
            const nextQuery = e.target.value;
            if (nextQuery === queryRef.current) return;
            queryRef.current = nextQuery;
            if (nextQuery.trim()) invalidateListRequest();
            setError(null);
            setQuery(nextQuery);
          }}
          className="search-input"
          maxLength={1024}
          aria-describedby="search-byte-limit"
          aria-invalid={queryTooLarge}
          autoFocus
        />
        <Link to="/new" className="btn btn-primary">
          + New
        </Link>
      </div>

      <p id="search-byte-limit" className="search-byte-limit">
        {queryBytes.toLocaleString()} / {MAX_SEARCH_QUERY_BYTES.toLocaleString()} UTF-8 bytes
      </p>

      {queryTooLarge && (
        <div className="error" role="alert">
          Search query exceeds the 1 KiB UTF-8 limit.
        </div>
      )}

      {searchResult && searchResult.answer && (
        <div className="search-answer" aria-live="polite">
          <strong>Answer:</strong> {searchResult.answer}
        </div>
      )}

      {visibleError && (
        <div className="error" role="alert">
          <p>{visibleError}</p>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => query.trim() ? retrySearch() : void loadMemories()}
          >
            Try again
          </button>
        </div>
      )}
      {loading && <div className="loading" role="status" aria-live="polite">Loading…</div>}

      {!loading && displayItems.length === 0 && (
        <div className="empty">
          {queryTooLarge
            ? "Shorten the search query to continue."
            : query
              ? "No memories found."
              : "No memories yet. Create one!"}
        </div>
      )}

      <div className="memory-list">
        {displayItems.map((m) => (
          <div key={m.id} className="memory-card">
            <div className="memory-card-header">
              <Link
                to="/memory/$id"
                params={{ id: m.id }}
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
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => handleDelete(m.id)}
                aria-label={`Delete memory: ${m.summary}`}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {!query.trim() && !searchResult && cursor && (
        <div className="load-more">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={loadMore}
            disabled={loading || loadingMore}
          >
            {loadingMore ? "Loading…" : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}
