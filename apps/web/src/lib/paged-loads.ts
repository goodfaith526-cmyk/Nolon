import { useCallback, useMemo, useRef, useState } from 'react';

/** What a list loaded page by page needs to keep its rows right while requests are in flight. */
export interface PagedLoads {
  /** A first page (a new search or filter): every reply still in flight becomes stale. */
  first(): number;
  /**
   * The next page of the rows shown: null while any page is loading (a second click, or a new
   * search not back yet), so nothing is sent.
   */
  next(): number | null;
  /** Whether a reply still belongs to the rows shown (no newer first page since). */
  current(token: number): boolean;
  /** A load ended (reply, error or stale). */
  done(token: number): void;
  /** The rows were cleared (the search text changed): every reply in flight becomes stale. */
  reset(): void;
}

/**
 * Guards a list with a "show more" button: one page at a time, and a reply overtaken by a newer
 * search is dropped instead of being added to the new rows. `loads` stays the same object across
 * renders (safe in effect dependencies); `loading` disables the button.
 */
export function usePagedLoads(): { loads: PagedLoads; loading: boolean } {
  const latest = useRef(0);
  const inFlight = useRef<number | null>(null);
  const [loading, setLoading] = useState(false);

  const start = useCallback((token: number) => {
    inFlight.current = token;
    setLoading(true);
    return token;
  }, []);
  const first = useCallback(() => start(++latest.current), [start]);
  const next = useCallback(
    () => (inFlight.current !== null ? null : start(latest.current)),
    [start],
  );
  const current = useCallback((token: number) => token === latest.current, []);
  const done = useCallback((token: number) => {
    if (inFlight.current === token) {
      inFlight.current = null;
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    latest.current += 1;
    inFlight.current = null;
    setLoading(false);
  }, []);

  const loads = useMemo(
    () => ({ first, next, current, done, reset }),
    [first, next, current, done, reset],
  );
  return { loads, loading };
}
