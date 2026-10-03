'use client';

import {
  CUSTOMER_KINDS,
  type CustomerDto,
  type CustomerSummaryDto,
  type Page,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { can, useMe } from '../StaffShell';
import { Notice, type NoticeState, useFailureText } from './Notice';

export function Customers() {
  const t = useTranslations('Customers');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const failure = useFailureText();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<CustomerSummaryDto> | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      api<Page<CustomerSummaryDto>>(`/customers?pageSize=50&q=${encodeURIComponent(query)}`)
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'customers:view')) return <p className="error">{tc('noAccess')}</p>;

  const branchLabel = (id: string) => {
    const branch = me.branches.find((b) => b.id === id);
    return branch ? name(branch) : '';
  };

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {!creating && can(me, 'customers:create') && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            {t('add')}
          </button>
        )}
      </div>
      <Notice notice={notice} />
      {creating && (
        <CustomerForm
          onCancel={() => setCreating(false)}
          onSaved={(c) => router.push(`/customers/${c.id}`)}
        />
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
                <th>{t('branch')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((c) => (
                <tr key={c.id} className={c.isActive ? '' : 'inactive'}>
                  <td dir="ltr">
                    <Link href={`/customers/${c.id}`}>{c.number}</Link>
                  </td>
                  <td>
                    {c.name}
                    {c.companyName ? <div className="muted">{c.companyName}</div> : null}
                  </td>
                  <td dir="ltr">{c.phone}</td>
                  <td>{branchLabel(c.branchId)}</td>
                  <td>{c.isActive ? tc('active') : tc('inactive')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{tc('shown', { shown: page.items.length, total: page.total })}</p>
        </div>
      )}
    </section>
  );
}

/** Text value or null when blank, so optional fields are cleared rather than set to "". */
function opt(form: FormData, key: string): string | null {
  const value = field(form, key).trim();
  return value === '' ? null : value;
}

export function CustomerForm({
  customer,
  onCancel,
  onSaved,
}: {
  customer?: CustomerDto;
  onCancel: () => void;
  onSaved: (c: CustomerDto) => void;
}) {
  const t = useTranslations('Customers');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const creditLimit = opt(form, 'creditLimit');
    const body = {
      kind: field(form, 'kind'),
      name: field(form, 'name'),
      companyName: opt(form, 'companyName'),
      phone: field(form, 'phone').replace(/\s/g, ''),
      whatsapp: opt(form, 'whatsapp')?.replace(/\s/g, '') ?? null,
      email: opt(form, 'email'),
      city: opt(form, 'city'),
      address: opt(form, 'address'),
      taxNumber: opt(form, 'taxNumber'),
      preferredCurrency: opt(form, 'preferredCurrency'),
      preferredLocale: field(form, 'preferredLocale'),
      paymentTermsDays: Number.parseInt(field(form, 'paymentTermsDays') || '0', 10),
      creditLimit,
      creditLimitCurrency: creditLimit ? opt(form, 'creditLimitCurrency') : null,
      notes: opt(form, 'notes'),
    };
    setBusy(true);
    setNotice(null);
    try {
      const saved = customer
        ? await api<CustomerDto>(`/customers/${customer.id}`, { method: 'PATCH', body })
        : await api<CustomerDto>('/customers', {
            method: 'POST',
            body: { ...body, branchId: field(form, 'branchId') },
          });
      onSaved(saved);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  const currencies = master?.currencies.filter((c) => c.isActive) ?? [];

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h2>{customer ? t('editTitle', { name: customer.name }) : t('add')}</h2>
      <Notice notice={notice} />
      <div className="grid">
        {!customer && (
          <label className="field">
            {t('branch')}
            <select name="branchId" required>
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {name(b)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          {t('kind')}
          <select name="kind" defaultValue={customer?.kind ?? 'COMPANY'}>
            {CUSTOMER_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind_${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('name')}
          <input name="name" required maxLength={200} defaultValue={customer?.name} />
        </label>
        <label className="field">
          {t('companyName')}
          <input name="companyName" maxLength={200} defaultValue={customer?.companyName ?? ''} />
        </label>
        <label className="field">
          {t('phone')}
          <input
            name="phone"
            required
            dir="ltr"
            placeholder="+249912345678"
            pattern="\+?[0-9 ]{7,20}"
            defaultValue={customer?.phone}
          />
        </label>
        <label className="field">
          {t('whatsapp')}
          <input name="whatsapp" dir="ltr" defaultValue={customer?.whatsapp ?? ''} />
        </label>
        <label className="field">
          {t('email')}
          <input name="email" type="email" dir="ltr" defaultValue={customer?.email ?? ''} />
        </label>
        <label className="field">
          {t('city')}
          <input name="city" maxLength={100} defaultValue={customer?.city ?? ''} />
        </label>
        <label className="field">
          {t('address')}
          <input name="address" maxLength={500} defaultValue={customer?.address ?? ''} />
        </label>
        <label className="field">
          {t('taxNumber')}
          <input name="taxNumber" maxLength={50} defaultValue={customer?.taxNumber ?? ''} />
        </label>
        <label className="field">
          {t('preferredCurrency')}
          <select name="preferredCurrency" defaultValue={customer?.preferredCurrency ?? ''}>
            <option value="">—</option>
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {name(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('preferredLocale')}
          <select name="preferredLocale" defaultValue={customer?.preferredLocale ?? 'ar'}>
            <option value="ar">{t('locale_ar')}</option>
            <option value="en">{t('locale_en')}</option>
          </select>
        </label>
        <label className="field">
          {t('paymentTermsDays')}
          <input
            name="paymentTermsDays"
            type="number"
            min={0}
            max={365}
            defaultValue={customer?.paymentTermsDays ?? 0}
          />
        </label>
        <label className="field">
          {t('creditLimit')}
          <input
            name="creditLimit"
            inputMode="decimal"
            dir="ltr"
            pattern="\d{1,14}(\.\d{1,4})?"
            defaultValue={customer?.creditLimit ?? ''}
          />
        </label>
        <label className="field">
          {t('creditLimitCurrency')}
          <select name="creditLimitCurrency" defaultValue={customer?.creditLimitCurrency ?? 'USD'}>
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        {t('notes')}
        <textarea name="notes" maxLength={2000} defaultValue={customer?.notes ?? ''} />
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {tc('save')}
        </button>
        <button type="button" onClick={onCancel}>
          {tc('cancel')}
        </button>
      </div>
    </form>
  );
}
