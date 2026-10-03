'use client';

import type { CustomerSummaryDto, Page } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { api } from '@/lib/api';

/** Search customers by name, number or phone and pick one. */
export function CustomerPicker({
  value,
  onChange,
}: {
  value: CustomerSummaryDto | null;
  onChange: (c: CustomerSummaryDto | null) => void;
}) {
  const t = useTranslations('Common');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CustomerSummaryDto[]>([]);

  async function search() {
    const page = await api<Page<CustomerSummaryDto>>(
      `/customers?pageSize=20&q=${encodeURIComponent(q)}`,
    );
    setResults(page.items.filter((c) => c.isActive));
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

  return (
    <div className="stack">
      <div className="row">
        <input
          type="search"
          value={q}
          placeholder={t('customerSearch')}
          onChange={(e) => setQ(e.target.value)}
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
      </div>
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
    </div>
  );
}
