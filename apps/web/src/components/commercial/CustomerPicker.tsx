'use client';

import type { CustomerSummaryDto, Page } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { can, useMe } from '../StaffShell';
import { CustomerForm } from './Customers';

/**
 * Search customers by name, number or phone and pick one. With `allowCreate`, someone who may
 * create customers can add one from here at any time, without searching first (the typed text
 * becomes the new customer's name), and it is picked.
 */
export function CustomerPicker({
  value,
  onChange,
  allowCreate = false,
}: {
  value: CustomerSummaryDto | null;
  onChange: (c: CustomerSummaryDto | null) => void;
  allowCreate?: boolean;
}) {
  const t = useTranslations('Common');
  const me = useMe();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerSummaryDto[]>([]);
  const [searched, setSearched] = useState(false);
  const [adding, setAdding] = useState(false);

  const [failed, setFailed] = useState(false);

  async function search() {
    setFailed(false);
    try {
      const page = await api<Page<CustomerSummaryDto>>(
        `/customers?pageSize=20&q=${encodeURIComponent(q)}`,
      );
      setResults(page.items.filter((c) => c.isActive));
      setSearched(true);
    } catch {
      setFailed(true);
    }
  }

  if (value) {
    return (
      <div className="row">
        <strong>
          {value.name} <span dir="ltr">({value.number})</span>
        </strong>
        <button type="button" onClick={() => onChange(null)}>
          {t('change')}
        </button>
      </div>
    );
  }

  const mayCreate = allowCreate && can(me, 'customers:create');

  return (
    <div className="stack">
      <div className="row">
        <input
          type="search"
          value={q}
          placeholder={t('customerSearch')}
          onChange={(e) => {
            setQ(e.target.value);
            setSearched(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void search();
            }
          }}
        />
        <button type="button" onClick={() => void search()}>
          {t('search')}
        </button>
        {mayCreate && (
          <button type="button" onClick={() => setAdding(true)}>
            {t('addNewCustomer')}
          </button>
        )}
      </div>
      {failed && <p className="error">{t('failed')}</p>}
      {results.length > 0 && (
        <ul className="picker">
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onChange(c)}>
                {c.name}{' '}
                <span dir="ltr">
                  · {c.number} · {c.phone}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {searched && results.length === 0 && <p className="muted">{t('customerNotFound')}</p>}
      {adding && (
        <NewCustomerDialog
          initialName={q.trim()}
          onClose={() => setAdding(false)}
          onSaved={(c) => {
            setAdding(false);
            onChange(c);
          }}
        />
      )}
    </div>
  );
}

/**
 * The customer form in a modal dialog. It is rendered at the end of the page, outside the form
 * the picker sits in (a form inside a form is not valid HTML), and its submit stops here: React
 * passes events up through a portal, and the outer form must not submit with it.
 */
function NewCustomerDialog({
  initialName,
  onClose,
  onSaved,
}: {
  initialName: string;
  onClose: () => void;
  onSaved: (c: CustomerSummaryDto) => void;
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
      className="form-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onSubmit={(e) => e.stopPropagation()}
    >
      <CustomerForm initialName={initialName} onCancel={onClose} onSaved={onSaved} />
    </dialog>,
    document.body,
  );
}
