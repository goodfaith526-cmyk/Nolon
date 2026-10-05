'use client';

import { useTranslations } from 'next-intl';
import { Children, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { icons } from './Icons';

/**
 * Secondary actions behind one "More" button, so a page shows its main action and keeps the rest
 * one click away. Children are the usual buttons and links; picking one closes the menu.
 * Closes on Escape and on a click outside.
 */
export function MoreMenu({
  children,
  label,
  primary,
}: {
  children: ReactNode;
  label?: string;
  /** Styles the button as the page's main action (e.g. one "New" menu). */
  primary?: boolean;
}) {
  const tc = useTranslations('Common');
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing to offer (every item hidden by status or permission): no button at all.
  if (Children.toArray(children).length === 0) return null;

  return (
    <div className="more-menu" ref={root}>
      <button
        type="button"
        className={primary ? 'primary' : undefined}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label ?? tc('more')}</span>
        {icons.chevron}
      </button>
      {open && (
        // A click on any item (button or link) runs it and closes the menu.
        <div id={id} className="more-menu-list" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
