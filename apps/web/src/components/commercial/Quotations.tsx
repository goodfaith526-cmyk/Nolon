'use client';

import {
  QUOTATION_STATUSES,
  type Page,
  type QuotationStatus,
  type QuotationSummaryDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { can, useMe } from '../StaffShell';
import { Notice, type NoticeState, useFailureText } from './Notice';

export function Quotations() {
  const t = useTranslations('Quotations');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const failure = useFailureText();
  const [status, setStatus] = useState<QuotationStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<QuotationSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<QuotationSummaryDto>>(
        `/quotations?pageSize=50${filter}&q=${encodeURIComponent(query)}`,
      )
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'quotations:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'quotations:create') && (
          <Link href="/quotations/new" className="button primary">
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
        <select value={status} onChange={(e) => setStatus(e.target.value as QuotationStatus | '')}>
          <option value="">{tc('all')}</option>
          {QUOTATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`quotation_${s}`)}
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
                <th>{t('total')}</th>
                <th>{t('validUntil')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((x) => (
                <tr key={x.id}>
                  <td dir="ltr">
                    <Link href={`/quotations/${x.id}`}>{x.number}</Link>
                  </td>
                  <td>{x.customerName}</td>
                  <td>
                    {tc('route', {
                      from: locationName(x.originLocationId),
                      to: locationName(x.destinationLocationId),
                    })}
                  </td>
                  <td dir="ltr">
                    {x.total} {x.currency}
                  </td>
                  <td dir="ltr">{x.validUntil}</td>
                  <td>{te(`quotation_${x.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
