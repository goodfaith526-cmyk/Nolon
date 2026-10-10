'use client';

import { DRAFT_STATUSES, type DraftStatus, type EntryDraftReviewFields } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { can, useMe } from '../StaffShell';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { DRAFT_KINDS, type DraftKind } from './draft-kinds';
import { DraftStatusBadge } from './DraftFrame';

type ListItem = EntryDraftReviewFields & { lineCount: number };

/**
 * Drafts the staff assistant proposed, by entry type, for the user's branches. Nothing in a draft
 * is recorded until a person opens it and approves it.
 */
export function AssistantDrafts() {
  const t = useTranslations('Drafts');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const failure = useFailureText();
  const kinds = DRAFT_KINDS.filter((k) => can(me, k.view));
  const [kind, setKind] = useState<DraftKind | null>(kinds[0]?.key ?? null);
  const [status, setStatus] = useState<DraftStatus | ''>('DRAFT');
  // Rows with the list they were loaded for, so a change of type or status shows loading.
  const [loaded, setLoaded] = useState<{ key: string; rows: ListItem[] } | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const current = DRAFT_KINDS.find((k) => k.key === kind);
  const listKey = current ? `${current.api}${status ? `?status=${status}` : ''}` : '';
  useEffect(() => {
    if (!listKey) return;
    let cancelled = false;
    api<ListItem[]>(listKey)
      .then((rows) => {
        if (!cancelled) setLoaded({ key: listKey, rows });
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [listKey, failure]);

  if (!current) return <p className="error">{tc('noAccess')}</p>;
  const items = loaded?.key === listKey ? loaded.rows : null;
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('hint')}</p>
      <Notice notice={notice} />
      <div className="row">
        <div className="row" role="group" aria-label={t('kind')}>
          {kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              className={k.key === kind ? 'primary' : undefined}
              aria-pressed={k.key === kind}
              onClick={() => setKind(k.key)}
            >
              {t(`kind_${k.key}`)}
            </button>
          ))}
        </div>
        <select
          value={status}
          aria-label={tc('status')}
          onChange={(e) => setStatus(e.target.value as DraftStatus | '')}
        >
          <option value="">{tc('all')}</option>
          {DRAFT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status_${s}`)}
            </option>
          ))}
        </select>
      </div>
      {items === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : items.length === 0 ? (
        <p className="muted">{tc('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('proposedAt')}</th>
                <th>{t('customer')}</th>
                <th>{t('proposedForColumn')}</th>
                <th>{t('lines')}</th>
                <th>{tc('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>{dateTime.format(new Date(d.createdAt))}</td>
                  <td>{d.customerName}</td>
                  <td>{d.createdByName}</td>
                  <td>{d.lineCount}</td>
                  <td>
                    <DraftStatusBadge status={d.status} />
                  </td>
                  <td>
                    <Link href={`/drafts/${current.key}/${d.id}`}>{t('review')}</Link>
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
