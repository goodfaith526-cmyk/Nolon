'use client';

import type { AccountDto, AuthMeResponse } from '@nolon/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { failureStatus } from '@/lib/master-data';
import { formatAmount } from '@/lib/money';
import { type NoticeState, useFailureText } from '../commercial/Notice';

/** An amount as the API returned it, digits grouped, with its currency. Always left to right. */
export function Money({ value, currency }: { value: string; currency?: string }) {
  return (
    <span dir="ltr" className="money">
      {formatAmount(value)}
      {currency ? ` ${currency}` : ''}
    </span>
  );
}

/** A branch's code from the signed-in user's branches; '…' when it is not one of them. */
export function useBranchCode(me: AuthMeResponse): (id: string) => string {
  return useCallback((id: string) => me.branches.find((b) => b.id === id)?.code ?? '…', [me]);
}

/**
 * One record by path. On failure, `notice` holds the message and `status` the HTTP status (0 when
 * unknown).
 */
export function useRecord<T>(path: string): {
  record: T | null;
  notice: NoticeState | null;
  status: number | null;
  setRecord: (record: T) => void;
} {
  const failure = useFailureText();
  const [record, setRecord] = useState<T | null>(null);
  const [error, setError] = useState<{ notice: NoticeState; status: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<T>(path)
      .then((r) => {
        if (!cancelled) setRecord(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError({ notice: { ok: false, text: failure(e) }, status: failureStatus(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, failure]);
  return {
    record,
    notice: error?.notice ?? null,
    status: error?.status ?? null,
    setRecord,
  };
}

/**
 * The chart of accounts, for account dropdowns. `status` is set when the call failed (403 when
 * the user cannot view the chart).
 */
export function useAccounts(): { accounts: AccountDto[] | null; status: number | null } {
  const { record, status } = useRecord<AccountDto[]>('/accounting/accounts');
  return { accounts: record, status };
}

/** A cancel (or similar) panel that asks for a reason before it calls `onSubmit`. */
export function ReasonForm({
  hint,
  label,
  submitLabel,
  backLabel,
  busy,
  onSubmit,
  onBack,
}: {
  hint?: string;
  label: string;
  submitLabel: string;
  backLabel: string;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onBack: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason);
      }}
    >
      {hint && <p>{hint}</p>}
      <label className="field">
        {label}
        <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" onClick={onBack}>
          {backLabel}
        </button>
      </div>
    </form>
  );
}

/** Cash and bank accounts a document of `branchId` in `currency` may use (dropdown narrowing). */
export function cashAccountsFor(
  accounts: AccountDto[] | null,
  branchId: string,
  currency: string,
): AccountDto[] {
  return (accounts ?? []).filter(
    (a) =>
      a.isCash &&
      a.isActive &&
      a.isPostable &&
      a.currency === currency &&
      (a.branchId === null || a.branchId === branchId),
  );
}
