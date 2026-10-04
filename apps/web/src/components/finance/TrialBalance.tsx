'use client';

import type { TrialBalanceDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { todayString } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { Money } from './common';

/** Trial balance in USD, as of a date, for one branch or all the user may see. */
export function TrialBalance() {
  const t = useTranslations('TrialBalance');
  const tc = useTranslations('Common');
  const te = useTranslations('Enums');
  const me = useMe();
  const name = useLocalName();
  const failure = useFailureText();
  // Users limited to their branches pick one of them; "all" is for all-branch roles.
  const [filter, setFilter] = useState(() => ({
    asOf: todayString(),
    branchId: me.allBranches ? '' : (me.branches[0]?.id ?? ''),
  }));
  const [report, setReport] = useState<TrialBalanceDto | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    const branch = filter.branchId ? `&branchId=${filter.branchId}` : '';
    api<TrialBalanceDto>(`/accounting/trial-balance?asOf=${filter.asOf}${branch}`)
      .then(setReport)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [filter, failure]);

  useEffect(load, [load]);

  if (!can(me, 'financial_reports:view')) return <p className="error">{tc('noAccess')}</p>;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setNotice(null);
    setFilter({ asOf: field(form, 'asOf') || todayString(), branchId: field(form, 'branchId') });
  }

  return (
    <section className="stack">
      <div className="row">
        <h1>{t('title')}</h1>
      </div>
      <p className="muted">{t('hint')}</p>
      <Notice notice={notice} />
      <form className="row" onSubmit={onSubmit}>
        <label className="field inline">
          {t('asOf')}
          <input type="date" name="asOf" required defaultValue={filter.asOf} />
        </label>
        <label className="field inline">
          {t('branch')}
          <select name="branchId" defaultValue={filter.branchId}>
            {me.allBranches && <option value="">{t('allBranches')}</option>}
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">{t('show')}</button>
      </form>
      {report === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : report.rows.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('code')}</th>
                <th>{t('account')}</th>
                <th>{t('type')}</th>
                <th>{t('debitUsd')}</th>
                <th>{t('creditUsd')}</th>
                <th>{t('balanceUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.accountId}>
                  <td dir="ltr">{r.code}</td>
                  <td>{name(r)}</td>
                  <td>{te(`accountType_${r.type}`)}</td>
                  <td dir="ltr">
                    <Money value={r.debitUsd} />
                  </td>
                  <td dir="ltr">
                    <Money value={r.creditUsd} />
                  </td>
                  <td dir="ltr">
                    <Money value={r.balanceUsd} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={3}>{t('total')}</th>
                <th dir="ltr">
                  <Money value={report.totalDebitUsd} currency="USD" />
                </th>
                <th dir="ltr">
                  <Money value={report.totalCreditUsd} currency="USD" />
                </th>
                <th />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
