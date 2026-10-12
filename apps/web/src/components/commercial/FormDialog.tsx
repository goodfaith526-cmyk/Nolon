'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * A form in a modal dialog. It is rendered at the end of the page, outside any form the opener
 * sits in (a form inside a form is not valid HTML), and its submit stops here: React passes events
 * up through a portal, and the outer form must not submit with it.
 */
export function FormDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
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
      className="form-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onSubmit={(e) => e.stopPropagation()}
    >
      {children}
    </dialog>,
    document.body,
  );
}
