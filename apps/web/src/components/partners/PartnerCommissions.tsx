'use client';

import {
  COMMISSION_ROLES,
  type CommissionBalanceDto,
  type CommissionRole,
  type CreatePartnerStatementInput,
  type ManualCommissionInput,
  type PartnerCommissionsDto,
  type PartnerDto,
  type PartnerStatementDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useMasterData } from '@/lib/master-data';
import { todayString } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money } from '../finance/common';

/**
 * A partner's commissions (plan 07, rule 16): what is open per branch and currency (with a statement
 * of it, rule 16a), the commissions that could not be computed (with a recompute), the statements,
 * the latest rows, and a manual adjustment. The API computes every figure and decides who may do
 * what; this page only shows them.
 */
export function PartnerCommissions({ partner }: { partner: PartnerDto }) {
  const t = useTranslations('PartnerCommissions');
  const tc = useTranslations('Common');
  const master = useMasterData();
  const failure = useFailureText();
  const [data, setData] = useState<PartnerCommissionsDto | null>(null);
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [stating, setStating] = useState<CommissionBalanceDto | null>(null);
  // One id per opened form: a retry of the same adjustment posts it once (F153-1).
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(() => {
    api<PartnerCommissionsDto>(`/partners/${partner.id}/commissions`)
      .then(setData)
      .catch((e: unknown) => setNotice({ ok: false, text: failure(e) }));
  }, [partner.id, failure]);

  useEffect(load, [load]);

  async function run(path: string, body: unknown, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      await api(path, { method: 'POST', body });
      setNotice({ ok: true, text: success });
      setAdding(false);
      load();
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  function adjust(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: ManualCommissionInput = {
      requestId,
      shipmentId: field(form, 'shipmentId'),
      role: field(form, 'role') as CommissionRole,
      currency: field(form, 'currency'),
      amount: field(form, 'amount'),
      reason: field(form, 'reason'),
    };
    void run(`/partners/${partner.id}/commissions/adjustments`, body, t('adjusted'));
  }

  async function makeStatement(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!stating) return;
    const body: CreatePartnerStatementInput = {
      branchId: stating.branchId,
      currency: stating.currency,
      periodTo: field(new FormData(e.currentTarget), 'periodTo'),
    };
    setBusy(true);
    setNotice(null);
    try {
      const made = await api<PartnerStatementDto>(`/partners/${partner.id}/statements`, {
        method: 'POST',
        body,
      });
      router.push(`/partner-statements/${made.id}`);
    } catch (err) {
      setNotice({ ok: false, text: failure(err) });
      setBusy(false);
    }
  }

  const shipments = [...new Map((data?.rows ?? []).map((r) => [r.shipmentId, r])).values()];

  return (
    <section className="stack">
      <div className="row">
        <h2>{t('title')}</h2>
        {!adding && data?.canAdjust && shipments.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setRequestId(crypto.randomUUID());
              setAdding(true);
            }}
          >
            {t('adjust')}
          </button>
        )}
      </div>
      <Notice notice={notice} />
      {adding && (
        <form className="card stack" autoComplete="off" onSubmit={adjust}>
          <div className="grid">
            <label className="field">
              {t('shipment')}
              <select name="shipmentId" required>
                {shipments.map((s) => (
                  <option key={s.shipmentId} value={s.shipmentId}>
                    {s.shipmentNumber}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t('role')}
              <select name="role" required>
                {COMMISSION_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`role_${role}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t('currency')}
              <select name="currency" required defaultValue={partner.currency}>
                {master?.currencies
                  .filter((c) => c.isActive)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              {t('amountSigned')}
              <input name="amount" required inputMode="decimal" dir="ltr" pattern="-?\d+(\.\d+)?" />
            </label>
          </div>
          <label className="field">
            {t('reason')}
            <textarea name="reason" required minLength={3} maxLength={500} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {tc('save')}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      {data === null ? (
        <p className="muted">{tc('loading')}</p>
      ) : (
        <>
          {data.balances.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('branch')}</th>
                    <th>{t('open')}</th>
                    <th>{t('openUsd')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.balances.map((b) => (
                    <tr key={`${b.branchId}:${b.currency}`}>
                      <td>{b.branchCode}</td>
                      <td dir="ltr">
                        <Money value={b.open} currency={b.currency} />
                      </td>
                      <td dir="ltr">
                        <Money value={b.openUsd} currency="USD" />
                      </td>
                      <td>
                        {b.canStatement && (
                          <button type="button" disabled={busy} onClick={() => setStating(b)}>
                            {t('makeStatement')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stating && (
            <form className="card row" autoComplete="off" onSubmit={(e) => void makeStatement(e)}>
              <strong>
                {stating.branchCode} · {stating.currency}
              </strong>
              <label className="field">
                {t('periodTo')}
                <input type="date" name="periodTo" required defaultValue={todayString()} />
              </label>
              <div className="actions">
                <button type="submit" className="primary" disabled={busy}>
                  {t('makeStatement')}
                </button>
                <button type="button" onClick={() => setStating(null)}>
                  {tc('cancel')}
                </button>
              </div>
            </form>
          )}
          <h3>{t('statements')}</h3>
          {data.statements.length === 0 ? (
            <p className="muted">{t('noStatements')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('number')}</th>
                    <th>{t('branch')}</th>
                    <th>{t('periodTo')}</th>
                    <th>{t('total')}</th>
                    <th>{t('status')}</th>
                    <th>{t('bill')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.statements.map((s) => (
                    <tr key={s.id}>
                      <td dir="ltr">
                        <Link href={`/partner-statements/${s.id}`}>{s.number}</Link>
                      </td>
                      <td>{s.branchCode}</td>
                      <td dir="ltr">{s.periodTo}</td>
                      <td dir="ltr">
                        <Money value={s.total} currency={s.currency} />
                      </td>
                      <td>{t(`statementStatus_${s.status}`)}</td>
                      <td dir="ltr">
                        {s.billId ? (
                          <Link href={`/supplier-bills/${s.billId}`}>{s.billNumber ?? '—'}</Link>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.holds.length > 0 && (
            <>
              <h3>{t('holds')}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('shipment')}</th>
                      <th>{t('role')}</th>
                      <th>{t('reasonHeld')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.holds.map((h) => (
                      <tr key={`${h.shipmentId}:${h.role}`}>
                        <td>
                          <Link href={`/shipments/${h.shipmentId}`}>{h.shipmentNumber}</Link>
                        </td>
                        <td>{t(`role_${h.role}`)}</td>
                        <td>{t(`hold_${h.code}`)}</td>
                        <td>
                          {h.canRecompute && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  `/shipments/${h.shipmentId}/commissions/recompute`,
                                  undefined,
                                  t('recomputed'),
                                )
                              }
                            >
                              {t('recompute')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {data.rows.length === 0 ? (
            <p className="muted">{t('none')}</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('date')}</th>
                    <th>{t('shipment')}</th>
                    <th>{t('role')}</th>
                    <th>{t('kind')}</th>
                    <th>{t('amount')}</th>
                    <th>{t('amountUsd')}</th>
                    <th>{t('entry')}</th>
                    <th>{t('state')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr">{row.createdAt.slice(0, 10)}</td>
                      <td>
                        <Link href={`/shipments/${row.shipmentId}`}>{row.shipmentNumber}</Link>
                      </td>
                      <td>{t(`role_${row.role}`)}</td>
                      <td title={row.reason ?? undefined}>{t(`kind_${row.kind}`)}</td>
                      <td dir="ltr">
                        <Money value={row.amount} currency={row.currency} />
                      </td>
                      <td dir="ltr">
                        <Money value={row.amountUsd} currency="USD" />
                      </td>
                      <td dir="ltr">{row.entryNumber}</td>
                      <td>{row.statementId ? t('inStatement') : t('openRow')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
