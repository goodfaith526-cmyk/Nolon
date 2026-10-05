'use client';

import {
  CONSOLIDATION_STATUSES,
  type ConsolidationStatus,
  type ConsolidationSummaryDto,
  type Page,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { useLocationName, useMasterData } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { useBranchCode } from '../finance/common';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';

/** Consolidated (LCL) containers of the user's branches. */
export function Consolidations() {
  const t = useTranslations('Consolidations');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const master = useMasterData();
  const locationName = useLocationName(master);
  const branchCode = useBranchCode(me);
  const failure = useFailureText();
  const [status, setStatus] = useState<ConsolidationStatus | ''>('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<ConsolidationSummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(
    (query: string) => {
      const filter = status ? `&status=${status}` : '';
      api<Page<ConsolidationSummaryDto>>(
        `/consolidations?pageSize=50${filter}&q=${encodeURIComponent(query)}`,
      )
        .then(setPage)
        .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
    },
    [status, failure],
  );

  useEffect(() => load(''), [load]);

  if (!can(me, 'consolidation:view')) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('hint')}</p>
        </div>
        {can(me, 'consolidation:create') && (
          <Link href="/consolidations/new" className="button primary">
            {t('new')}
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
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ConsolidationStatus | '')}
        >
          <option value="">{tc('all')}</option>
          {CONSOLIDATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {te(`consolidation_${s}`)}
            </option>
          ))}
        </select>
        <button type="submit">{tc('search')}</button>
      </form>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="empty">{t('none')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('route')}</th>
                <th>{t('container')}</th>
                <th>{t('vessel')}</th>
                <th>{t('etd')}</th>
                <th>{t('eta')}</th>
                <th>{t('shipmentsCount')}</th>
                <th>{tc('status')}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((c) => (
                <tr key={c.id} className={c.status === 'CANCELLED' ? 'inactive' : ''}>
                  <td dir="ltr">
                    <Link href={`/consolidations/${c.id}`}>{c.number}</Link>
                    <div className="muted">{branchCode(c.branchId)}</div>
                  </td>
                  <td>
                    {tc('route', {
                      from: locationName(c.originLocationId),
                      to: locationName(c.destinationLocationId),
                    })}
                  </td>
                  <td dir="ltr">
                    {c.containerTypeCode}
                    {c.containerNumber && <div className="muted">{c.containerNumber}</div>}
                  </td>
                  <td>{c.vesselName ?? '—'}</td>
                  <td dir="ltr">{c.etd ?? '—'}</td>
                  <td dir="ltr">{c.eta ?? '—'}</td>
                  <td>{c.shipmentCount}</td>
                  <td>
                    <StatusBadge kind="consolidation" status={c.status} />
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
