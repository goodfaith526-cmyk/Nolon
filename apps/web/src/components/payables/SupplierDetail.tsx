'use client';

import type { CarrierDto, SupplierDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useApiList } from '../finance/reports/ReportKit';
import { useRecord } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { SupplierFields, supplierFields } from './Suppliers';

export function SupplierDetail({ id }: { id: string }) {
  const t = useTranslations('Suppliers');
  const tc = useTranslations('Common');
  const me = useMe();
  const failure = useFailureText();
  const {
    record: supplier,
    notice: loadNotice,
    setRecord,
  } = useRecord<SupplierDto>(`/suppliers/${id}`);
  const canLink = Boolean(supplier?.actions.canEdit) && can(me, 'transport_fleet:view');
  const carriers = useApiList<CarrierDto>('/transport/carriers', canLink);
  const [editing, setEditing] = useState(false);
  const [carrierId, setCarrierId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  if (!supplier) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function run(path: string, method: 'PATCH' | 'PUT' | 'DELETE', body?: unknown) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await api<SupplierDto>(path, { method, body }));
      setEditing(false);
      setCarrierId('');
      setNotice({ ok: true, text: tc('saved') });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void run(`/suppliers/${id}`, 'PATCH', supplierFields(new FormData(e.currentTarget)));
  }

  const s = supplier;
  const unlinked = (carriers ?? []).filter((c) => c.isActive && c.supplierId === null);

  return (
    <section className="stack">
      <div className="row">
        <h1>
          {s.name}{' '}
          <span className="muted" dir="ltr">
            {s.number}
          </span>
        </h1>
        <span className={`badge ${s.isActive ? 'badge-ACTIVE' : 'badge-INACTIVE'}`}>
          {s.isActive ? tc('active') : tc('inactive')}
        </span>
      </div>
      <Notice notice={notice} />
      <div className="actions">
        {s.actions.canEdit && !editing && (
          <button type="button" onClick={() => setEditing(true)}>
            {tc('edit')}
          </button>
        )}
        {s.actions.canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(`/suppliers/${id}`, 'PATCH', { isActive: !s.isActive })}
          >
            {s.isActive ? tc('deactivate') : tc('activate')}
          </button>
        )}
        {can(me, 'suppliers:view') && (
          <Link href={`/supplier-bills?supplierId=${id}`} className="button">
            {t('bills')}
          </Link>
        )}
      </div>

      {editing ? (
        <form className="card stack" onSubmit={save}>
          <SupplierFields supplier={s} />
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      ) : (
        <dl className="details">
          <dt>{t('phone')}</dt>
          <dd dir="ltr">{s.phone ?? '—'}</dd>
          <dt>{t('email')}</dt>
          <dd dir="ltr">{s.email ?? '—'}</dd>
          <dt>{t('taxNumber')}</dt>
          <dd dir="ltr">{s.taxNumber ?? '—'}</dd>
          <dt>{t('paymentTermsDays')}</dt>
          <dd dir="ltr">{s.paymentTermsDays}</dd>
          {s.notes && (
            <>
              <dt>{tc('notes')}</dt>
              <dd className="pre">{s.notes}</dd>
            </>
          )}
        </dl>
      )}

      <h2>{t('carriers')}</h2>
      <p className="muted">{t('carriersHint')}</p>
      {s.carriers.length === 0 ? (
        <p className="muted">{t('noCarriers')}</p>
      ) : (
        <ul className="stack">
          {s.carriers.map((c) => (
            <li key={c.id} className="row">
              <span>{c.name}</span>
              {canLink && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(`/suppliers/${id}/carriers/${c.id}`, 'DELETE')}
                >
                  {tc('remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canLink && s.isActive && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(`/suppliers/${id}/carriers/${carrierId}`, 'PUT', {});
          }}
        >
          <select value={carrierId} required onChange={(e) => setCarrierId(e.target.value)}>
            <option value="">{t('chooseCarrier')}</option>
            {unlinked.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy || carrierId === ''}>
            {t('linkCarrier')}
          </button>
        </form>
      )}
    </section>
  );
}
