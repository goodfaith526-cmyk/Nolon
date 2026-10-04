'use client';

import type { Page, SupplierDto, SupplierInput, SupplierSummaryDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';

/** The supplier form's fields as the API takes them; empty texts are sent as null. */
export function supplierFields(form: FormData): SupplierInput {
  const text = (name: string) => field(form, name).trim() || null;
  const terms = field(form, 'paymentTermsDays').trim();
  return {
    name: field(form, 'name').trim(),
    phone: text('phone'),
    email: text('email'),
    taxNumber: text('taxNumber'),
    // An integer count of days, not money: the input's pattern allows digits only.
    paymentTermsDays: terms === '' ? 0 : Number.parseInt(terms, 10),
    notes: text('notes'),
  };
}

export function SupplierFields({ supplier }: { supplier?: SupplierDto }) {
  const t = useTranslations('Suppliers');
  const tc = useTranslations('Common');
  return (
    <>
      <div className="grid">
        <label className="field">
          {t('name')}
          <input name="name" required maxLength={200} defaultValue={supplier?.name} />
        </label>
        <label className="field">
          {t('phone')}
          <input
            name="phone"
            dir="ltr"
            placeholder="+249..."
            defaultValue={supplier?.phone ?? ''}
          />
        </label>
        <label className="field">
          {t('email')}
          <input name="email" type="email" dir="ltr" defaultValue={supplier?.email ?? ''} />
        </label>
        <label className="field">
          {t('taxNumber')}
          <input
            name="taxNumber"
            dir="ltr"
            maxLength={50}
            defaultValue={supplier?.taxNumber ?? ''}
          />
        </label>
        <label className="field">
          {t('paymentTermsDays')}
          <input
            name="paymentTermsDays"
            inputMode="numeric"
            pattern="\d{1,4}"
            dir="ltr"
            defaultValue={String(supplier?.paymentTermsDays ?? 0)}
          />
        </label>
      </div>
      <label className="field">
        {tc('notes')}
        <textarea name="notes" maxLength={2000} defaultValue={supplier?.notes ?? ''} />
      </label>
    </>
  );
}

export function Suppliers() {
  const t = useTranslations('Suppliers');
  const tc = useTranslations('Common');
  const me = useMe();
  const router = useRouter();
  const failure = useFailureText();
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<SupplierSummaryDto> | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      api<Page<SupplierSummaryDto>>(`/suppliers?pageSize=50&q=${encodeURIComponent(query)}`)
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'suppliers:view')) return <p className="error">{tc('noAccess')}</p>;

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<SupplierDto>('/suppliers', {
        method: 'POST',
        body: supplierFields(new FormData(e.currentTarget)),
      });
      router.push(`/suppliers/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'suppliers:create') && !adding && (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            {t('add')}
          </button>
        )}
      </div>
      <Notice notice={notice} />
      {adding && (
        <form className="card stack" onSubmit={(e) => void create(e)}>
          <h2>{t('add')}</h2>
          <SupplierFields />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          load(q);
        }}
      >
        <input
          type="search"
          value={q}
          placeholder={t('search')}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit">{tc('search')}</button>
      </form>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('name')}</th>
                <th>{t('phone')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((s) => (
                <tr key={s.id} className={s.isActive ? '' : 'inactive'}>
                  <td dir="ltr">
                    <Link href={`/suppliers/${s.id}`}>{s.number}</Link>
                  </td>
                  <td>{s.name}</td>
                  <td dir="ltr">{s.phone ?? '—'}</td>
                  <td>{s.isActive ? tc('active') : tc('inactive')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
