'use client';

import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';

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
export function Tabs({ tabs, label }: { tabs: Tab[]; label: string }) {
  const id = useId();
  // Staff pages render in the browser only (after the session loads), so the hash is readable.
  const [selected, setSelected] = useState(() => {
    const fromHash = typeof window === 'undefined' ? '' : window.location.hash.slice(1);
    return tabs.some((t) => t.key === fromHash) ? fromHash : (tabs[0]?.key ?? '');
  });

  function select(key: string) {
    setSelected(key);
    window.history.replaceState(null, '', `#${key}`);
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
