import { useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches now, following its changes. False on the server and where
 * the browser has no matchMedia, so the first render never disagrees with the server's.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}
