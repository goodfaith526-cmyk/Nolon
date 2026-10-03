'use client';

import {
  BOOKING_STATUSES,
  type BookingStatus,
  type BookingSummaryDto,
  type Page,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { can, useMe } from '../StaffShell';
import { Notice, type NoticeState, useFailureText } from './Notice';

export function Bookings() {
  const t = useTranslations('Bookings');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const failure = useFailureText();
  const [status, setStatus] = useState<BookingStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<BookingSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<BookingSummaryDto>>(`/bookings?pageSize=50${filter}&q=${encodeURIComponent(query)}`)
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'bookings:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'bookings:create') && (
          <Link href="/bookings/new" className="button primary">
            {t('add')}
          </Link>
        )}
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
        <select value={status} onChange={(e) => setStatus(e.target.value as BookingStatus | '')}>
          <option value="">{tc('all')}</option>
          {BOOKING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`booking_${s}`)}
            </option>
          ))}
        </select>
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
                <th>{t('customer')}</th>
                <th>{t('route')}</th>
                <th>{t('mode')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((b) => (
                <tr key={b.id} className={b.status === 'CANCELLED' ? 'inactive' : ''}>
                  <td dir="ltr">
                    <Link href={`/bookings/${b.id}`}>{b.number}</Link>
                  </td>
                  <td>{b.customerName}</td>
                  <td>
                    {tc('route', {
                      from: locationName(b.originLocationId),
                      to: locationName(b.destinationLocationId),
                    })}
                  </td>
                  <td>{te(`mode_${b.mode}`)}</td>
                  <td>{te(`booking_${b.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
