import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResponse } from "./api";
import { useDebouncedSearch, type SearchFunction } from "./use-debounced-search";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function result(summary: string): SearchResponse {
  return {
    count: 1,
    answer: "",
    candidates: [{ id: summary, summary, sessionId: null, score: 1 }],
  };
}

describe("useDebouncedSearch", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for the debounce window before searching", async () => {
    vi.useFakeTimers();
    const search = vi.fn<SearchFunction>().mockResolvedValue(result("match"));
    const { result: hook } = renderHook(() =>
      useDebouncedSearch("memory", true, 400, search),
    );

    await act(() => vi.advanceTimersByTimeAsync(399));
    expect(search).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(search).toHaveBeenCalledOnce();
    await act(() => Promise.resolve());
    expect(hook.current.result?.candidates[0]?.summary).toBe("match");
  });

  it("aborts an old query and ignores a late stale response", async () => {
    vi.useFakeTimers();
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    const signals: AbortSignal[] = [];
    const search: SearchFunction = vi.fn((query, _params, signal) => {
      if (signal) signals.push(signal);
      return query === "first" ? first.promise : second.promise;
    });
    const { result: hook, rerender } = renderHook(
      ({ query }) => useDebouncedSearch(query, true, 10, search),
      { initialProps: { query: "first" } },
    );

    await act(() => vi.advanceTimersByTimeAsync(10));
    rerender({ query: "second" });
    expect(signals[0]?.aborted).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(10));

    await act(async () => second.resolve(result("new result")));
    expect(hook.current.result?.candidates[0]?.summary).toBe("new result");
    await act(async () => first.resolve(result("stale result")));
    expect(hook.current.result?.candidates[0]?.summary).toBe("new result");
  });
});
