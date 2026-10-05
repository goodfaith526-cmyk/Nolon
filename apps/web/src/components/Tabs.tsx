'use client';

import { type KeyboardEvent, type ReactNode, useId, useSyncExternalStore } from 'react';

export interface Tab {
  key: string;
  label: string;
  content: ReactNode;
}

/**
 * Sections of a long page as tabs. Every panel stays mounted (hidden when not selected) so each
 * section keeps its own state and loads once, as it did on the single long page. The selected
 * tab is kept in the URL hash, so a link or a reload opens the same section.
 */
function subscribeToHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function readHash(): string {
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return ''; // A malformed hash (a stray %) opens the first tab.
  }
}

export function Tabs({ tabs, label }: { tabs: Tab[]; label: string }) {
  const id = useId();
  // The server render and hydration see no hash (first tab); the real hash is read right after,
  // so they never disagree. An unknown or hidden tab in the hash falls back to the first tab.
  const hash = useSyncExternalStore(subscribeToHash, readHash, () => '');
  const selected = tabs.some((t) => t.key === hash) ? hash : (tabs[0]?.key ?? '');

  function select(key: string) {
    // replaceState keeps Back for leaving the page and does not scroll; it fires no event itself.
    window.history.replaceState(null, '', `#${encodeURIComponent(key)}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((t) => t.key === selected);
    const rtl = document.documentElement.dir === 'rtl';
    const step =
      event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
    if (step === 0 || index < 0) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (!next) return;
    select(next.key);
    document.getElementById(`${id}-tab-${next.key}`)?.focus();
  }

  return (
    <div className="tabs">
      <div className="tab-list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.key}
            id={`${id}-tab-${t.key}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={t.key === selected}
            aria-controls={`${id}-panel-${t.key}`}
            tabIndex={t.key === selected ? 0 : -1}
            onClick={() => select(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.key}
          id={`${id}-panel-${t.key}`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${t.key}`}
          className="tab-panel stack"
          hidden={t.key !== selected}
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
