'use client';

import type { WarehouseDto, WindowCashAccountDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLocalName } from '@/lib/master-data';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { cashAccountsFor, useAccounts } from '../finance/common';
import { can, useMe } from '../StaffShell';

/**
 * Plan 13 section 4: the cash accounts a window takes the customer's money into, one per currency.
 * Kept by the accountant (chart of accounts rights); the API checks each account (an active cash
 * account of its currency, the window's branch or shared, serving no other window).
 */
export function WindowCashAccounts({ warehouse: w }: { warehouse: WarehouseDto }) {
  const t = useTranslations('Warehouse');
  const me = useMe();
  const name = useLocalName();
  const failure = useFailureText();
  const { accounts } = useAccounts();
  const [rows, setRows] = useState<WindowCashAccountDto[] | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  // The load's refusal itself; its text is made when shown (failure() is not stable).
  const [loadError, setLoadError] = useState<unknown>(null);
  const path = `/warehouses/${w.id}/cash-accounts`;
  const canEdit = can(me, 'chart_of_accounts:update');

  // Only the answer sets state, so the first load can run from an effect.
  const fetchRows = useCallback(() => {
    api<WindowCashAccountDto[]>(path)
      .then(setRows)
      .catch((err: unknown) => {
        setRows([]);
        setLoadError(err);
      });
  }, [path]);
  useEffect(() => fetchRows(), [fetchRows]);

  const cash = [
    ...new Set((accounts ?? []).flatMap((a) => (a.isCash && a.currency ? [a.currency] : []))),
  ].flatMap((currency) => cashAccountsFor(accounts, w.branchId, currency));

  async function change(method: 'PUT' | 'DELETE', currency: string, accountId?: string) {
    setBusy(true);
    setNotice(null);
    try {
      const next = await api<WindowCashAccountDto[]>(`${path}/${currency}`, {
        method,
        body: accountId ? { accountId } : undefined,
      });
      setRows(next);
      setChoice('');
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="panel-body">
      <summary>{t('windowCashTitle')}</summary>
      <p className="muted">{t('windowCashHint')}</p>
      <Notice notice={loadError === null ? notice : { ok: false, text: failure(loadError) }} />
      {rows === null ? null : rows.length === 0 ? (
        <p className="empty">{t('windowCashNone')}</p>
      ) : (
        <ul className="stack">
          {rows.map((r) => (
            <li key={r.currency} className="row">
              <span>
                <span dir="ltr">{r.currency}</span> · <span dir="ltr">{r.accountCode}</span>{' '}
                {name({ nameEn: r.accountNameEn, nameAr: r.accountNameAr })}
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="button small"
                  disabled={busy}
                  onClick={() => void change('DELETE', r.currency)}
                >
                  {t('windowCashRemove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const account = cash.find((a) => a.id === choice);
            if (account?.currency) void change('PUT', account.currency, account.id);
          }}
        >
          <select
            value={choice}
            aria-label={t('windowCashAccount')}
            onChange={(e) => setChoice(e.target.value)}
            required
          >
            <option value="">{t('windowCashAccount')}</option>
            {cash.map((a) => (
              <option key={a.id} value={a.id}>
                {a.currency} · {a.code} · {name(a)}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy || choice === ''}>
            {t('windowCashSet')}
          </button>
        </form>
      )}
    </details>
  );
}
