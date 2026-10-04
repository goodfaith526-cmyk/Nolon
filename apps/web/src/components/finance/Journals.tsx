'use client';

import {
  JOURNAL_SOURCES,
  JOURNAL_STATUSES,
  type JournalEntrySummaryDto,
  type JournalSource,
  type JournalStatus,
  type Page,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { Money, useBranchCode } from './common';

export function Journals() {
  const t = useTranslations('Journals');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const branchCode = useBranchCode(me);
  const failure = useFailureText();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<Page<JournalEntrySummaryDto> | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<Page<JournalEntrySummaryDto>>(`/accounting/journals?pageSize=50${query}`)
      .then(setPage)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [query, failure]);

  useEffect(load, [load]);

  if (!can(me, 'manual_journals:view')) return <p className="error">{tc('noAccess')}</p>;

  function onFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const params = new URLSearchParams();
    for (const key of ['q', 'status', 'source', 'from', 'to']) {
      const value = field(form, key).trim();
      if (value) params.set(key, value);
    }
    const text = params.toString();
    setNotice(null);
    setQuery(text ? `&${text}` : '');
  }

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
        {can(me, 'manual_journals:create') && (
          <Link href="/accounting/journals/new" className="button primary">
            {t('add')}
          </Link>
        )}
      </div>
      <Notice notice={notice} />
      <form className="row" onSubmit={onFilter}>
        <input type="search" name="q" placeholder={t('search')} />
        <select name="status" defaultValue="" aria-label={tc('status')}>
          <option value="">{t('allStatuses')}</option>
          {JOURNAL_STATUSES.map((s: JournalStatus) => (
            <option key={s} value={s}>
              {te(`journal_${s}`)}
            </option>
          ))}
        </select>
        <select name="source" defaultValue="" aria-label={t('source')}>
          <option value="">{t('allSources')}</option>
          {JOURNAL_SOURCES.map((s: JournalSource) => (
            <option key={s} value={s}>
              {te(`journalSource_${s}`)}
            </option>
          ))}
        </select>
        <label className="field inline">
          {t('from')}
          <input type="date" name="from" />
        </label>
        <label className="field inline">
          {t('to')}
          <input type="date" name="to" />
        </label>
        <button type="submit">{tc('search')}</button>
      </form>
      {page === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('number')}</th>
                  <th>{t('entryDate')}</th>
                  <th>{t('branch')}</th>
                  <th>{t('description')}</th>
                  <th>{t('source')}</th>
                  <th>{t('totalUsd')}</th>
                  <th>{tc('status')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((j) => (
                  <tr key={j.id}>
                    <td dir="ltr">
                      <Link href={`/accounting/journals/${j.id}`}>{j.number}</Link>
                    </td>
                    <td dir="ltr">{j.entryDate}</td>
                    <td dir="ltr">{branchCode(j.branchId)}</td>
                    <td>{j.description}</td>
                    <td className="nowrap">{te(`journalSource_${j.source}`)}</td>
                    <td dir="ltr">
                      <Money value={j.totalUsd} currency="USD" />
                    </td>
                    <td>
                      <span className="actions">
                        <StatusBadge kind="journal" status={j.status} />
                        {j.reversedById && <span className="badge">{t('reversed')}</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.total > page.items.length && (
            <p className="muted">{tc('shown', { shown: page.items.length, total: page.total })}</p>
          )}
        </>
      )}
    </section>
  );
}
