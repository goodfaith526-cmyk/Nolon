'use client';

import type {
  CreateManualJournalRequest,
  JournalEntryDto,
  ManualJournalInput,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { AMOUNT_PATTERN, FX_RATE_PATTERN, todayString } from '@/lib/money';
import { icons } from '../Icons';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { useAccounts, useRecord } from './common';

interface LineState {
  key: number;
  accountId: string;
  currency: string;
  fxRate: string;
  debit: string;
  credit: string;
  description: string;
}

let nextKey = 1;
const emptyLine = (): LineState => ({
  key: nextKey++,
  accountId: '',
  currency: 'USD',
  fxRate: '',
  debit: '',
  credit: '',
  description: '',
});

/** Loads a draft manual entry for editing. */
export function JournalEdit({ id }: { id: string }) {
  const t = useTranslations('Journals');
  const tc = useTranslations('Common');
  const { record, notice } = useRecord<JournalEntryDto>(`/accounting/journals/${id}`);
  if (notice) return <Notice notice={notice} />;
  if (!record) return <p className="muted">{tc('loading')}</p>;
  if (!record.actions.canEdit) {
    return (
      <section className="stack">
        <p className="error">{t('notEditable')}</p>
        <div>
          <Link href={`/accounting/journals/${id}`} className="button">
            {tc('back')}
          </Link>
        </div>
      </section>
    );
  }
  return <JournalForm entry={record} />;
}

/**
 * New manual entry, or edit of a draft. A draft need not balance; posting checks that. USD amounts
 * and the totals are computed by the API.
 */
export function JournalForm({ entry }: { entry?: JournalEntryDto }) {
  const t = useTranslations('Journals');
  const tc = useTranslations('Common');
  const me = useMe();
  const name = useLocalName();
  const master = useMasterData();
  const failure = useFailureText();
  const router = useRouter();
  const { accounts, status: accountsStatus } = useAccounts();
  const [branchChoice, setBranch] = useState(entry?.branchId ?? '');
  const [lines, setLines] = useState<LineState[]>(() =>
    entry
      ? entry.lines.map((l) => ({
          key: nextKey++,
          accountId: l.accountId,
          currency: l.currency,
          fxRate: l.currency === 'USD' ? '' : l.fxRate,
          debit: l.debit === '0' ? '' : l.debit,
          credit: l.credit === '0' ? '' : l.credit,
          description: l.description ?? '',
        }))
      : [emptyLine(), emptyLine()],
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const branchId = branchChoice || (me.branches[0]?.id ?? '');
  const permission = entry ? 'manual_journals:update' : 'manual_journals:create';
  if (!can(me, permission)) return <p className="error">{tc('noAccess')}</p>;

  function updateLine(key: number, patch: Partial<LineState>) {
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const input: ManualJournalInput = {
      entryDate: field(form, 'entryDate'),
      description: field(form, 'description').trim(),
      lines: lines.map((l) => ({
        accountId: l.accountId,
        currency: l.currency,
        fxRate: l.currency === 'USD' || l.fxRate.trim() === '' ? null : l.fxRate.trim(),
        debit: l.debit.trim() || undefined,
        credit: l.credit.trim() || undefined,
        description: l.description.trim() || null,
      })),
    };
    setBusy(true);
    setNotice(null);
    try {
      const saved = entry
        ? await api<JournalEntryDto>(`/accounting/journals/${entry.id}`, {
            method: 'PATCH',
            body: input,
          })
        : await api<JournalEntryDto>('/accounting/journals', {
            method: 'POST',
            body: { ...input, branchId } satisfies CreateManualJournalRequest,
          });
      router.push(`/accounting/journals/${saved.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  if (!master) return <p className="muted">{tc('loading')}</p>;
  if (accountsStatus !== null) {
    return <p className="error">{accountsStatus === 403 ? t('accountsNoAccess') : tc('failed')}</p>;
  }
  // Dropdown narrowing only: manual entries post to active, postable, non-control accounts. The
  // API checks each line again.
  const postable = (accounts ?? []).filter(
    (a) => (a.isPostable && a.isActive && !a.isControl) || lines.some((l) => l.accountId === a.id),
  );

  return (
    <form className="stack form-page" onSubmit={(e) => void submit(e)}>
      <h1>{entry ? t('editTitle', { number: entry.number }) : t('add')}</h1>
      <Notice notice={notice} />
      <section className="form-section">
        <header>
          <h2>{t('sectionEntry')}</h2>
          <p>{t('sectionEntryHint')}</p>
        </header>
        <div className="form-section-body form-grid">
          <label className="field">
            {t('branch')}
            <select
              value={branchId}
              disabled={entry !== undefined}
              onChange={(e) => setBranch(e.target.value)}
            >
              {me.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {name(b)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t('entryDate')}
            <input
              name="entryDate"
              type="date"
              required
              defaultValue={entry?.entryDate ?? todayString()}
            />
          </label>
          <label className="field span-all">
            {t('description')}
            <textarea
              name="description"
              rows={2}
              required
              maxLength={1000}
              defaultValue={entry?.description ?? ''}
            />
          </label>
        </div>
      </section>

      <section className="form-section wide">
        <header>
          <h2>{t('lines')}</h2>
          <p>{t('linesHint')}</p>
        </header>
        <fieldset className="form-section-body stack bare">
          <legend className="visually-hidden">{t('lines')}</legend>
          {lines.map((l, index) => (
            <div key={l.key} className="line">
              <span className="muted">{index + 1}</span>
              <label className="field grow">
                {t('account')}
                <select
                  required
                  value={l.accountId}
                  onChange={(e) => updateLine(l.key, { accountId: e.target.value })}
                >
                  <option value="">{t('chooseAccount')}</option>
                  {postable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {name(a)}
                      {a.currency ? ` (${a.currency})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {t('currency')}
                <select
                  value={l.currency}
                  onChange={(e) => updateLine(l.key, { currency: e.target.value })}
                >
                  {master.currencies
                    .filter((c) => c.isActive || c.code === l.currency)
                    .map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                {t('fxRateOptional')}
                <input
                  inputMode="decimal"
                  dir="ltr"
                  pattern={FX_RATE_PATTERN}
                  disabled={l.currency === 'USD'}
                  value={l.currency === 'USD' ? '' : l.fxRate}
                  onChange={(e) => updateLine(l.key, { fxRate: e.target.value })}
                />
              </label>
              <label className="field">
                {t('debit')}
                <input
                  inputMode="decimal"
                  dir="ltr"
                  pattern={AMOUNT_PATTERN}
                  value={l.debit}
                  onChange={(e) => updateLine(l.key, { debit: e.target.value })}
                />
              </label>
              <label className="field">
                {t('credit')}
                <input
                  inputMode="decimal"
                  dir="ltr"
                  pattern={AMOUNT_PATTERN}
                  value={l.credit}
                  onChange={(e) => updateLine(l.key, { credit: e.target.value })}
                />
              </label>
              <label className="field grow">
                {t('lineDescription')}
                <input
                  maxLength={500}
                  value={l.description}
                  onChange={(e) => updateLine(l.key, { description: e.target.value })}
                />
              </label>
              {lines.length > 2 && (
                <button
                  type="button"
                  className="ghost icon-button line-remove-button"
                  aria-label={tc('remove')}
                  title={tc('remove')}
                  onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}
                >
                  {icons.close}
                </button>
              )}
            </div>
          ))}
          <div>
            <button
              type="button"
              className="ghost add-line"
              onClick={() => setLines((all) => [...all, emptyLine()])}
            >
              {icons.plus}
              <span>{t('addLine')}</span>
            </button>
          </div>
        </fieldset>
      </section>

      <div className="actions form-footer">
        <button type="button" onClick={() => router.back()}>
          {tc('cancel')}
        </button>
        <button type="submit" className="primary" disabled={busy || accounts === null}>
          {t('saveDraft')}
        </button>
      </div>
    </form>
  );
}
