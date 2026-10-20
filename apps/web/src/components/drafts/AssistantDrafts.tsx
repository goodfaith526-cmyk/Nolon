'use client';

import {
  DRAFT_STATUSES,
  type DraftStatus,
  type EntryDraftReviewFields,
  type MyDraftKind,
  type ReviewDraftItemDto,
  type ReviewDraftsPageDto,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { can, useMe } from '../StaffShell';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { DRAFT_KINDS, type DraftKind, REVIEW_KINDS } from './draft-kinds';
import { DraftStatusBadge } from './DraftFrame';

type ListItem = EntryDraftReviewFields & { missingFields?: string[] };

/** The tab of every kind's drafts waiting for this reviewer. */
const WAITING = 'waiting';

/**
 * Drafts the staff assistant proposed. "Everything waiting" lists, across every kind (GRN drafts
 * included), the open drafts this reviewer may decide, as NOLON lists them for them; each kind's
 * tab lists that kind's drafts of the user's branches by status. Nothing in a draft is recorded
 * until a person opens it and approves it.
 */
export function AssistantDrafts() {
  const t = useTranslations('Drafts');
  const tc = useTranslations('Common');
  const me = useMe();
  const kinds = DRAFT_KINDS.filter((k) => can(me, k.view));
  const [tab, setTab] = useState<DraftKind | typeof WAITING>(WAITING);
  if (kinds.length === 0) return <p className="error">{tc('noAccess')}</p>;

  return (
    <section className="stack">
      <h1>{t('title')}</h1>
      <p className="muted">{t('hint')}</p>
      <div className="row" role="group" aria-label={t('kind')}>
        <button
          type="button"
          className={tab === WAITING ? 'primary' : undefined}
          aria-pressed={tab === WAITING}
          onClick={() => setTab(WAITING)}
        >
          {t('waitingTab')}
        </button>
        {kinds.map((k) => (
          <button
            key={k.key}
            type="button"
            className={k.key === tab ? 'primary' : undefined}
            aria-pressed={k.key === tab}
            onClick={() => setTab(k.key)}
          >
            {t(`kind_${k.key}`)}
          </button>
        ))}
      </div>
      {tab === WAITING ? <WaitingDrafts /> : <KindDrafts kind={tab} />}
    </section>
  );
}

/**
 * Everything waiting for this reviewer (GET /assistant-drafts/review), newest first, a page at a
 * time; filtered by kind. NOLON decides what is listed (the reviewer's permissions, branches and
 * whether they may decide each draft); this only shows it.
 */
function WaitingDrafts() {
  const t = useTranslations('Drafts');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const me = useMe();
  const failure = useFailureText();
  const kinds = REVIEW_KINDS.filter((k) => can(me, k.view));
  const [kind, setKind] = useState<MyDraftKind | ''>('');
  const [pages, setPages] = useState<{ kind: string; items: ReviewDraftItemDto[] } | null>(null);
  const [next, setNext] = useState<ReviewDraftsPageDto['next']>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ReviewDraftsPageDto>(`/assistant-drafts/review${kind ? `?kind=${kind}` : ''}`)
      .then((page) => {
        if (cancelled) return;
        setPages({ kind, items: page.items });
        setNext(page.next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [kind, failure]);

  async function more() {
    if (!next) return;
    setBusy(true);
    try {
      const query = new URLSearchParams({ before: next.before, beforeId: next.beforeId });
      if (kind) query.set('kind', kind);
      const page = await api<ReviewDraftsPageDto>(`/assistant-drafts/review?${query.toString()}`);
      setPages((p) => ({ kind, items: [...(p?.items ?? []), ...page.items] }));
      setNext(page.next);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  const items = pages?.kind === kind ? pages.items : null;
  const label = (k: MyDraftKind) => {
    const entry = REVIEW_KINDS.find((r) => r.kind === k);
    return entry ? t(`kind_${entry.key}`) : k;
  };
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="stack">
      <p className="muted">{t('waitingHint')}</p>
      <Notice notice={notice} />
      <label className="field">
        <span>{t('kind')}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as MyDraftKind | '')}>
          <option value="">{tc('all')}</option>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {t(`kind_${k.key}`)}
            </option>
          ))}
        </select>
      </label>
      {items === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : items.length === 0 && !next ? (
        <p className="muted">{t('waitingEmpty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('proposedAt')}</th>
                <th>{t('kind')}</th>
                <th>{t('subject')}</th>
                <th>{t('branch')}</th>
                <th>{t('proposedForColumn')}</th>
                <th>{t('missingColumn')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={`${d.kind}:${d.id}`}>
                  <td>{dateTime.format(new Date(d.createdAt))}</td>
                  <td>{label(d.kind)}</td>
                  <td>{d.subject}</td>
                  <td dir="ltr">{d.branchCode}</td>
                  <td>{d.createdByName}</td>
                  <td>
                    {d.missingCount === null ? '—' : t('missingCount', { n: d.missingCount })}
                  </td>
                  <td>
                    <Link href={d.reviewPath}>{t('review')}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && items !== null && (
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void more()}>
            {t('loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}

/** One kind's drafts for the user's branches, by status (its own review list). */
function KindDrafts({ kind }: { kind: DraftKind }) {
  const t = useTranslations('Drafts');
  const tc = useTranslations('Common');
  const locale = useLocale();
  const failure = useFailureText();
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
    <div className="stack">
      <Notice notice={notice} />
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
                <th>{t('subject')}</th>
                <th>{t('proposedForColumn')}</th>
                <th>{t('missingColumn')}</th>
                <th>{tc('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>{dateTime.format(new Date(d.createdAt))}</td>
                  <td>{d.subject}</td>
                  <td>{d.createdByName}</td>
                  <td>{t('missingCount', { n: d.missingFields?.length ?? 0 })}</td>
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
    </div>
  );
}
