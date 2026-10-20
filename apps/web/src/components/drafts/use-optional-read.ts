'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * A read a review screen can do without, for `path` (and `version`, so a draft saved since is
 * read again): its answer once loaded; null when not asked (no path) or refused (the screen then
 * works as it did without it); undefined while it loads.
 */
export function useOptionalRead<T>(path: string | null, version?: number): T | null | undefined {
  const [loaded, setLoaded] = useState<{ key: string; value: T | null } | null>(null);
  const key = path === null ? null : `${path}#${version ?? ''}`;
  useEffect(() => {
    if (path === null || key === null) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api<T>(path))
      .then((value) => {
        if (!cancelled) setLoaded({ key, value });
      })
      .catch(() => {
        // Optional: without it the screen offers what it did before.
        if (!cancelled) setLoaded({ key, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path, key]);
  if (key === null) return null;
  return loaded !== null && loaded.key === key ? loaded.value : undefined;
}
