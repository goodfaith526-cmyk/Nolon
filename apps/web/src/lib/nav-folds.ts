import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'nolon.nav.folded';
const listeners = new Set<() => void>();
/** Used when storage is unavailable (private mode): remembered until the page reloads. */
let fallback: string | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of the app folding a section.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

function readSaved(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return fallback;
  }
}

function parse<T extends string>(
  saved: string | null,
  allowed: readonly T[],
  defaults: readonly T[],
) {
  if (saved === null) return new Set(defaults);
  try {
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return new Set(defaults);
    return new Set(allowed.filter((title) => parsed.includes(title)));
  } catch {
    return new Set(defaults);
  }
}

/**
 * Which sidebar sections the user folded, remembered in this browser only. The server render and
 * the first client render both use the defaults; the saved choice is read after hydration, so the
 * two never disagree.
 */
export function useFoldedSections<T extends string>(
  allowed: readonly T[],
  defaults: readonly T[],
): [Set<T>, (title: T) => void] {
  // A string snapshot compares by value, so an unchanged storage entry never re-renders.
  const saved = useSyncExternalStore(subscribe, readSaved, () => null);
  const folded = parse(saved, allowed, defaults);

  function toggle(title: T) {
    const next = new Set(folded);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    const value = JSON.stringify([...next]);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      fallback = value;
    }
    for (const listener of listeners) listener();
  }

  return [folded, toggle];
}
