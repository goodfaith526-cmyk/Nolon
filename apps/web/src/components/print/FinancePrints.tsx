'use client';

import type {
  CustomerInvoiceDto,
  CustomerStatementDto,
  JournalEntryDto,
  ReceiptDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { field } from '@/lib/form';
import { useLocalName, useMasterData } from '@/lib/master-data';
import { todayString } from '@/lib/money';
import { startOfYear } from '@/lib/print';
import { Money, useRecord } from '../finance/common';
import { CustomerBlock, useCustomer } from './CommercialPrints';
import {
  DocFields,
  DocSection,
  DocumentSheet,
  PageStyle,
  PrintPending,
  PrintToolbar,
  SignatureBoxes,
  useDateTime,
  useQrSrc,
} from './PrintKit';

/** Printout 9: customer invoice, with the QR code of its shipment's public tracking page. */
export function InvoicePrint({ id }: { id: string }) {
  const t = useTranslations('Invoices');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const master = useMasterData();
  const name = useLocalName();
  const { record: inv, notice } = useRecord<CustomerInvoiceDto>(`/customer-invoices/${id}`);
  const customer = useCustomer(inv?.customerId ?? null);
  const qr = useQrSrc(inv?.shipmentId ?? null);
  if (!inv) return <PrintPending notice={notice} />;
  const chargeName = (code: string) => {
    const charge = master?.chargeTypes.find((c) => c.code === code);
    return charge ? name(charge) : code;
  };
  const watermark = inv.status === 'APPROVED' ? null : te(`invoice_${inv.status}`);
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/invoices/${id}`} ready={master !== null && qr !== null} />
      <DocumentSheet
        title={tp('invoiceTitle')}
        number={inv.number ?? t('draftNumber')}
        date={<span dir="ltr">{inv.invoiceDate}</span>}
        branchId={inv.branchId}
        qr={qr}
        watermark={watermark}
      >
        <div className="doc-columns">
          <CustomerBlock name={inv.customerName} customer={customer} />
          <DocFields
            fields={[
              [t('invoiceDate'), <span dir="ltr">{inv.invoiceDate}</span>],
              [t('dueDate'), <span dir="ltr">{inv.dueDate}</span>],
              [t('shipment'), <span dir="ltr">{inv.shipmentNumber}</span>],
              [t('currency'), <span dir="ltr">{inv.currency}</span>],
            ]}
          />
        </div>
        <DocSection title={t('lines')}>
          <table className="doc-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('chargeType')}</th>
                <th className="num">{t('quantity')}</th>
                <th className="num">{t('unitPrice')}</th>
                <th className="num">{t('lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td>{l.lineNo}</td>
                  <td>
                    {chargeName(l.chargeTypeCode)}
                    {l.description && <div className="muted">{l.description}</div>}
                  </td>
                  <td className="num" dir="ltr">
                    {l.quantity}
                  </td>
                  <td className="num">
                    <Money value={l.unitPrice} />
                  </td>
                  <td className="num">
                    <Money value={l.lineTotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="doc-totals">
            <dt className="grand">{t('total')}</dt>
            <dd className="grand">
              <Money value={inv.total} currency={inv.currency} />
            </dd>
            {inv.status === 'APPROVED' && (
              <>
                <dt>{t('paid')}</dt>
                <dd>
                  <Money value={inv.paidAmount} currency={inv.currency} />
                </dd>
                <dt>{t('balance')}</dt>
                <dd>
                  <strong>
                    <Money value={inv.balance} currency={inv.currency} />
                  </strong>
                </dd>
              </>
            )}
          </dl>
        </DocSection>
        {inv.notes && (
          <DocSection title={tp('notes')}>
            <p className="pre">{inv.notes}</p>
          </DocSection>
        )}
        {inv.cancelReason && (
          <DocSection title={t('cancelReason')}>
            <p>{inv.cancelReason}</p>
          </DocSection>
        )}
        <p className="muted">{tp('trackingNote')}</p>
      </DocumentSheet>
    </>
  );
}

/**
 * Printout 11: receipt voucher. The payment voucher is not printed: supplier payments are not
 * built yet.
 */
export function ReceiptPrint({ id }: { id: string }) {
  const t = useTranslations('Receipts');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const name = useLocalName();
  const { record: r, notice } = useRecord<ReceiptDto>(`/receipts/${id}`);
  const customer = useCustomer(r?.customerId ?? null);
  if (!r) return <PrintPending notice={notice} />;
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/receipts/${id}`} ready />
      <DocumentSheet
        title={tp('receiptTitle')}
        number={r.number}
        date={<span dir="ltr">{r.receiptDate}</span>}
        branchId={r.branchId}
        watermark={r.status === 'CANCELLED' ? te('receipt_CANCELLED') : null}
      >
        <div className="doc-columns">
          <CustomerBlock name={r.customerName} customer={customer} />
          <DocFields
            fields={[
              [t('receiptDate'), <span dir="ltr">{r.receiptDate}</span>],
              [
                t('cashAccount'),
                <>
                  <span dir="ltr">{r.cashAccountCode}</span> ·{' '}
                  {name({ nameEn: r.cashAccountNameEn, nameAr: r.cashAccountNameAr })}
                </>,
              ],
              [t('reference'), r.reference && <span dir="ltr">{r.reference}</span>],
              [tp('journalNumber'), <span dir="ltr">{r.journalEntryNumber}</span>],
            ]}
          />
        </div>
        <div className="doc-amount">
          <span>{t('amount')}</span>
          <strong>
            <Money value={r.amount} currency={r.currency} />
          </strong>
        </div>
        <DocSection title={t('allocations')}>
          {r.allocations.length === 0 ? (
            <p className="muted">{t('noAllocations')}</p>
          ) : (
            <table className="doc-table">
              <thead>
                <tr>
                  <th>{t('invoice')}</th>
                  <th className="num">{t('allocatedAmount')}</th>
                </tr>
              </thead>
              <tbody>
                {r.allocations.map((a) => (
                  <tr key={a.invoiceId}>
                    <td dir="ltr">{a.invoiceNumber}</td>
                    <td className="num">
                      <Money value={a.amount} currency={r.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="doc-totals">
            <dt>{t('allocated')}</dt>
            <dd>
              <Money value={r.allocated} currency={r.currency} />
            </dd>
            <dt>{t('unallocated')}</dt>
            <dd>
              <Money value={r.unallocated} currency={r.currency} />
            </dd>
          </dl>
        </DocSection>
        {r.notes && (
          <DocSection title={tp('notes')}>
            <p className="pre">{r.notes}</p>
          </DocSection>
        )}
        {r.status === 'CANCELLED' && (
          <DocSection title={t('cancelReason')}>
            <p>
              {r.cancelReason}
              {r.cancelJournalEntryNumber && (
                <>
                  {' · '}
                  <span dir="ltr">{r.cancelJournalEntryNumber}</span>
                </>
              )}
            </p>
          </DocSection>
        )}
        <SignatureBoxes labels={[tp('signCashier'), tp('signPayer')]} />
      </DocumentSheet>
    </>
  );
}

/**
 * Printout 12: customer statement of account, from the API's statement (posted lines only,
 * running balance per currency). Supplier statements are not printed: suppliers are not built.
 */
export function StatementPrint({
  customerId,
  from,
  to,
}: {
  customerId: string;
  from?: string;
  to?: string;
}) {
  const t = useTranslations('Print');
  const [period, setPeriod] = useState(() => {
    const today = todayString();
    return { from: from ?? startOfYear(today), to: to ?? today };
  });
  const query = new URLSearchParams(period).toString();
  const { record: s, notice } = useRecord<CustomerStatementDto>(
    `/customer-statements/${customerId}?${query}`,
  );
  const customer = useCustomer(customerId);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPeriod({ from: field(form, 'from'), to: field(form, 'to') });
  }

  const toolbar = (
    <PrintToolbar back={`/customers/${customerId}`} ready={s !== null}>
      <form className="row" onSubmit={onSubmit}>
        <label className="field">
          <span>{t('from')}</span>
          <input type="date" name="from" required defaultValue={period.from} />
        </label>
        <label className="field">
          <span>{t('to')}</span>
          <input type="date" name="to" required defaultValue={period.to} />
        </label>
        <button type="submit">{t('show')}</button>
      </form>
    </PrintToolbar>
  );
  const shown = s && s.from === period.from && s.to === period.to ? s : null;
  if (!shown) {
    return (
      <>
        {toolbar}
        <PrintPending notice={notice} />
      </>
    );
  }
  return (
    <>
      <PageStyle />
      {toolbar}
      <DocumentSheet
        title={t('statementTitle')}
        number={null}
        date={t('period', { from: shown.from, to: shown.to })}
        branchId={shown.customerBranchId}
      >
        <CustomerBlock name={shown.customerName} customer={customer} />
        {shown.sections.length === 0 && <p className="muted">{t('statementEmpty')}</p>}
        {shown.sections.map((section) => (
          <DocSection
            key={section.currency}
            title={t('inCurrency', { currency: section.currency })}
          >
            <table className="doc-table">
              <thead>
                <tr>
                  <th>{t('date')}</th>
                  <th>{t('document')}</th>
                  <th>{t('description')}</th>
                  <th className="num">{t('debit')}</th>
                  <th className="num">{t('credit')}</th>
                  <th className="num">{t('balance')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="subtotal">
                  <td dir="ltr">{shown.from}</td>
                  <td colSpan={4}>{t('openingBalance')}</td>
                  <td className="num">
                    <Money value={section.openingBalance} />
                  </td>
                </tr>
                {section.lines.map((l) => (
                  <tr key={l.entryId}>
                    <td dir="ltr">{l.date}</td>
                    <td>
                      {t(`kind_${l.kind}`)}
                      <div dir="ltr" className="muted">
                        {l.documentNumber ?? l.entryNumber}
                      </div>
                    </td>
                    <td>{l.description}</td>
                    <td className="num">{l.debit === '0' ? '' : <Money value={l.debit} />}</td>
                    <td className="num">{l.credit === '0' ? '' : <Money value={l.credit} />}</td>
                    <td className="num">
                      <Money value={l.balance} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>{t('periodTotals')}</td>
                  <td className="num">
                    <Money value={section.totalDebit} />
                  </td>
                  <td className="num">
                    <Money value={section.totalCredit} />
                  </td>
                  <td />
                </tr>
                <tr className="grand">
                  <td dir="ltr">{shown.to}</td>
                  <td colSpan={4}>{t('closingBalance')}</td>
                  <td className="num">
                    <Money value={section.closingBalance} currency={section.currency} />
                  </td>
                </tr>
              </tfoot>
            </table>
            {section.currency !== 'USD' && (
              <p className="muted">
                {t('closingUsd')} <Money value={section.closingBalanceUsd} currency="USD" />
              </p>
            )}
          </DocSection>
        ))}
        <p className="muted">{t('statementNote')}</p>
      </DocumentSheet>
    </>
  );
}

/** Journal voucher: one journal entry and its lines, from the journal entry screen. */
export function JournalPrint({ id }: { id: string }) {
  const t = useTranslations('Journals');
  const tp = useTranslations('Print');
  const te = useTranslations('Enums');
  const name = useLocalName();
  const dateTime = useDateTime();
  const { record: e, notice } = useRecord<JournalEntryDto>(`/accounting/journals/${id}`);
  if (!e) return <PrintPending notice={notice} />;
  return (
    <>
      <PageStyle />
      <PrintToolbar back={`/accounting/journals/${id}`} ready />
      <DocumentSheet
        title={tp('journalTitle')}
        number={e.number}
        date={<span dir="ltr">{e.entryDate}</span>}
        branchId={e.branchId}
        meta={<p>{te(`journal_${e.status}`)}</p>}
        watermark={e.status === 'DRAFT' ? te('journal_DRAFT') : null}
      >
        <DocFields
          fields={[
            [t('description'), e.description],
            [
              t('source'),
              <>
                {te(`journalSource_${e.source}`)}
                {e.sourceNumber && <div dir="ltr">{e.sourceNumber}</div>}
              </>,
            ],
            [t('reversalOf'), e.reversalOfNumber && <span dir="ltr">{e.reversalOfNumber}</span>],
            [t('reversedBy'), e.reversedByNumber && <span dir="ltr">{e.reversedByNumber}</span>],
            [t('createdBy'), e.createdByName],
            [
              t('postedBy'),
              e.postedByName && (
                <>
                  <bdi>{e.postedByName}</bdi>
                  <div className="muted">{dateTime(e.postedAt)}</div>
                </>
              ),
            ],
          ]}
        />
        <DocSection title={t('lines')}>
          <table className="doc-table compact">
            <thead>
              <tr>
                <th>#</th>
                <th>{t('account')}</th>
                <th>{tp('lineDetails')}</th>
                <th>{t('currency')}</th>
                <th className="num">{t('debit')}</th>
                <th className="num">{t('credit')}</th>
                <th className="num">{t('fxRate')}</th>
                <th className="num">{t('debitUsd')}</th>
                <th className="num">{t('creditUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td>{l.lineNo}</td>
                  <td>
                    <span dir="ltr">{l.accountCode}</span>{' '}
                    {name({ nameEn: l.accountNameEn, nameAr: l.accountNameAr })}
                  </td>
                  <td>
                    {l.description}
                    {l.shipmentNumber && <div dir="ltr">{l.shipmentNumber}</div>}
                    {l.customerName && <div>{l.customerName}</div>}
                  </td>
                  <td dir="ltr">{l.currency}</td>
                  <td className="num">{l.debit === '0' ? '' : <Money value={l.debit} />}</td>
                  <td className="num">{l.credit === '0' ? '' : <Money value={l.credit} />}</td>
                  <td className="num" dir="ltr">
                    {l.fxRate}
                  </td>
                  <td className="num">{l.debitUsd === '0' ? '' : <Money value={l.debitUsd} />}</td>
                  <td className="num">
                    {l.creditUsd === '0' ? '' : <Money value={l.creditUsd} />}
                  </td>
                </tr>
              ))}
            </tbody>
            {/* A posted entry balances: its debit and credit totals are both totalUsd. */}
            {e.status === 'POSTED' && (
              <tfoot>
                <tr className="grand">
                  <td colSpan={7}>{tp('totalUsd')}</td>
                  <td className="num">
                    <Money value={e.totalUsd} />
                  </td>
                  <td className="num">
                    <Money value={e.totalUsd} />
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </DocSection>
        <SignatureBoxes
          labels={[tp('signPreparedBy'), tp('signReviewedBy'), tp('signApprovedBy')]}
        />
      </DocumentSheet>
    </>
  );
}
