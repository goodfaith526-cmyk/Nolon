'use client';

import {
  SHIPMENT_STATUSES,
  type Page,
  type ShipmentStatus,
  type ShipmentSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

export function Shipments() {
  const t = useTranslations('Shipments');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const failure = useFailureText();
  const [status, setStatus] = useState<ShipmentStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<ShipmentSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<ShipmentSummaryDto>>(
        `/shipments?pageSize=50${filter}&q=${encodeURIComponent(query)}`,
      )
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'shipments:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        <Link href="/track" className="button">
          {t('publicLookup')}
        </Link>
      </div>
      <Notice notice={notice} />
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
        <select value={status} onChange={(e) => setStatus(e.target.value as ShipmentStatus | '')}>
          <option value="">{tc('all')}</option>
          {SHIPMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`shipment_${s}`)}
            </option>
          ))}
        </select>
        <button type="submit">{tc('search')}</button>
      </form>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('customer')}</th>
                <th>{t('route')}</th>
                <th>{t('mode')}</th>
                <th>{t('eta')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((s) => (
                <tr key={s.id} className={s.status === 'CANCELLED' ? 'inactive' : ''}>
                  <td dir="ltr">
                    <Link href={`/shipments/${s.id}`}>{s.number}</Link>
                  </td>
                  <td>{s.customerName}</td>
                  <td>
                    {tc('route', {
                      from: locationName(s.originLocationId),
                      to: locationName(s.destinationLocationId),
                    })}
                  </td>
                  <td>
                    {te(`mode_${s.mode}`)}
                    {s.loadType ? ` · ${s.loadType}` : ''}
                  </td>
                  <td dir="ltr">{s.eta ?? '—'}</td>
                  <td>
                    <StatusBadge kind="shipment" status={s.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
