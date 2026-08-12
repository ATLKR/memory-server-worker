import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SearchResponse } from "./api";

export type SearchFunction = (
  query: string,
  params?: {
    thinkingLevel?: "low" | "medium" | "high";
    responseLength?: "short" | "medium" | "long";
  },
  signal?: AbortSignal,
) => Promise<SearchResponse>;

export function useDebouncedSearch(
  query: string,
  enabled: boolean,
  delay = 400,
  search: SearchFunction = api.search,
) {
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const controller = new AbortController();

    setResult(null);
    setError(null);
    if (!enabled || !query.trim()) {
      setSearching(false);
      return () => controller.abort();
    }

    setSearching(true);
    const timer = window.setTimeout(() => {
      void search(query, undefined, controller.signal)
        .then((nextResult) => {
          if (!controller.signal.aborted && currentGeneration === generation.current) {
            setResult(nextResult);
          }
        })
        .catch((cause) => {
          if (
            !controller.signal.aborted &&
            currentGeneration === generation.current &&
            !(cause instanceof Error && cause.name === "AbortError")
          ) {
            setError(cause instanceof Error ? cause.message : "Search failed");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && currentGeneration === generation.current) {
            setSearching(false);
          }
        });
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (generation.current === currentGeneration) generation.current += 1;
    };
  }, [delay, enabled, query, revision, search]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);

  return { result, searching, error, retry };
}
