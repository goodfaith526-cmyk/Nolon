'use client';

import type {
  PartnerStatementBillInput,
  PartnerStatementDto,
  PartnerStatementLineDto,
  SupplierBillDueDateDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { todayString } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { PrintLink } from '../print/PrintLink';

/**
 * A partner statement (plan 07, 5): its commission rows and total, its supplier bill, and making
 * the bill or cancelling the statement where the API allows it. Approving and paying the bill
 * happen on the bill.
 */
export function PartnerStatement({ id }: { id: string }) {
  const t = useTranslations('PartnerStatement');
  const tp = useTranslations('PartnerCommissions');
  const tc = useTranslations('Common');
  const failure = useFailureText();
  const {
    record: statement,
    notice: loadNotice,
    setRecord,
  } = useRecord<PartnerStatementDto>(`/partner-statements/${id}`);
  const [billing, setBilling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  // One id per opened form, so a retry of the same press returns the same bill.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  if (!statement) {
    return loadNotice ? <Notice notice={loadNotice} /> : <p className="muted">{tc('loading')}</p>;
  }

  async function post(path: string, body: unknown, success: string) {
    setBusy(true);
    setNotice(null);
    try {
      setRecord(await api<PartnerStatementDto>(path, { method: 'POST', body }));
      setBilling(false);
      setNotice({ ok: true, text: success });
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
    } finally {
      setBusy(false);
    }
  }

  async function makeBill(form: FormData, supplierId: string | null) {
    const billDate = field(form, 'billDate');
    const supplierReference = field(form, 'supplierReference');
    let dueDate = field(form, 'dueDate');
    // Left empty, the due date is the API's suggestion from the supplier's terms, sent as the
    // request's own: a retry is then compared with what was asked for (F168-2). Without a
    // supplier the API refuses the bill, whatever the date.
    if (!dueDate) {
      setBusy(true);
      try {
        dueDate = supplierId
          ? (
              await api<SupplierBillDueDateDto>(
                `/supplier-bills/due-date?${new URLSearchParams({ supplierId, billDate }).toString()}`,
              )
            ).dueDate
          : billDate;
      } catch (err) {
        setNotice({ ok: false, text: failure(err) });
        setBusy(false);
        return;
      }
    }
    const body: PartnerStatementBillInput = {
      requestId,
      billDate,
      dueDate,
      ...(supplierReference ? { supplierReference } : {}),
    };
    await post(`/partner-statements/${id}/bill`, body, t('billed'));
  }

  function cancel() {
    if (!window.confirm(t('cancelConfirm'))) return;
    void post(`/partner-statements/${id}/cancel`, undefined, t('cancelled'));
  }

  const s = statement;
  return (
    <section className="stack">
      <div className="row">
        <h1>
          {t('title')} <span dir="ltr">{s.number}</span>
        </h1>
        <span className="badge">{tp(`statementStatus_${s.status}`)}</span>
      </div>
      <Notice notice={notice} />
      <div className="actions">
        {s.actions.canBill && !billing && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              setRequestId(crypto.randomUUID());
              setBilling(true);
            }}
          >
            {t('makeBill')}
          </button>
        )}
        {s.billId && (
          <Link href={`/supplier-bills/${s.billId}`} className="button">
            {t('bill')} <span dir="ltr">{s.billNumber ?? ''}</span>
          </Link>
        )}
        {s.actions.canCancel && (
          <button type="button" disabled={busy} onClick={cancel}>
            {t('cancel')}
          </button>
        )}
        <PrintLink href={`/partner-statements/${id}`} label={t('print')} />
      </div>
      {billing && (
        <form
          className="card stack"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void makeBill(new FormData(e.currentTarget), statement.partnerSupplierId);
          }}
        >
          <div className="grid">
            <label className="field">
              {t('billDate')}
              <input type="date" name="billDate" required defaultValue={todayString()} />
            </label>
            <label className="field">
              {t('dueDate')}
              <input type="date" name="dueDate" />
              <span className="muted">{t('dueDateHint')}</span>
            </label>
            <label className="field">
              {t('supplierReference')}
              <input name="supplierReference" maxLength={50} dir="ltr" />
            </label>
          </div>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t('makeBill')}
            </button>
            <button type="button" onClick={() => setBilling(false)}>
              {tc('cancel')}
            </button>
          </div>
        </form>
      )}
      <dl className="details">
        <dt>{t('partner')}</dt>
        <dd>
          <Link href={`/partners/${s.partnerId}`}>{s.partnerName}</Link>{' '}
          <span className="muted" dir="ltr">
            {s.partnerNumber}
          </span>
        </dd>
        <dt>{t('branch')}</dt>
        <dd>{s.branchCode}</dd>
        <dt>{t('periodTo')}</dt>
        <dd dir="ltr">{s.periodTo}</dd>
        <dt>{t('total')}</dt>
        <dd dir="ltr">
          <Money value={s.total} currency={s.currency} />
        </dd>
        {s.currency !== 'USD' && (
          <>
            <dt>{t('totalUsd')}</dt>
            <dd dir="ltr">
              <Money value={s.totalUsd} currency="USD" />
            </dd>
          </>
        )}
      </dl>
      <StatementLines statement={s} />
    </section>
  );
}

/** The statement's rows: a line per commission, then the manual adjustments, then the total. */
export function StatementLines({
  statement: s,
  className,
}: {
  statement: PartnerStatementDto;
  className?: string;
}) {
  const t = useTranslations('PartnerStatement');
  const tp = useTranslations('PartnerCommissions');
  const tk = useTranslations('PartnerContracts');
  const rate = (l: PartnerStatementLineDto) =>
    l.basis && l.value ? t(`basisValue_${l.basis}`, { value: l.value }) : '—';
  if (s.lines.length === 0) return <p className="muted">{t('noLines')}</p>;
  return (
    <div className="table-wrap">
      <table className={className}>
        <thead>
          <tr>
            <th>{t('date')}</th>
            <th>{t('shipment')}</th>
            <th>{t('role')}</th>
            <th>{t('event')}</th>
            <th>{t('basis')}</th>
            <th className="num">{t('base')}</th>
            <th className="num">{t('commission')}</th>
          </tr>
        </thead>
        <tbody>
          {s.lines.map((l, index) => (
            <tr key={`${l.shipmentId}:${index}`}>
              <td dir="ltr">{l.date}</td>
              <td dir="ltr">{l.shipmentNumber}</td>
              <td>{tp(`role_${l.role}`)}</td>
              <td>
                {l.kind === 'MANUAL'
                  ? t('manual', { reason: l.reason ?? '' })
                  : l.event
                    ? tk(`event_${l.event}`)
                    : tp(`kind_${l.kind}`)}
              </td>
              <td dir="ltr">{rate(l)}</td>
              <td className="num" dir="ltr">
                {l.base ? <Money value={l.base} /> : (l.quantity ?? '—')}
              </td>
              <td className="num" dir="ltr">
                <Money value={l.amount} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="grand">
            <td colSpan={6}>{t('total')}</td>
            <td className="num" dir="ltr">
              <Money value={s.total} currency={s.currency} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
