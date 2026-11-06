'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { icons } from './Icons';

/**
 * A side sheet over the page (screen review 2026-11-06): a record page's forms (update status,
 * edit details, hold, cancel) open here instead of pushing the page down. It is a modal dialog,
 * so focus stays inside and Escape closes it; on a phone it takes the whole screen.
 */
export function Drawer({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
    };
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className="drawer"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="drawer-sheet">
        <div className="drawer-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="ghost icon-button"
            aria-label={closeLabel}
            onClick={onClose}
          >
            {icons.close}
          </button>
        </div>
        <div className="drawer-body stack">{children}</div>
      </div>
    </dialog>,
    document.body,
  );
}
