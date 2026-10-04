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
