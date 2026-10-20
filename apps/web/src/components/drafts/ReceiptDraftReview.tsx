'use client';

import type { ReceiptCashAccountDto, ReceiptDraftDto, ReceiptOpenInvoiceDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useLocalName } from '@/lib/master-data';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { DraftFrame } from './DraftFrame';
import { MissingFields } from './MissingFields';
import { useOptionalRead } from './use-optional-read';

/** A receipt the assistant proposed: the amount, the cash account and the invoices it settles. */
export function ReceiptDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tr = useTranslations('Receipts');
  const tc = useTranslations('Common');
  const name = useLocalName();
  const { record: draft, notice, setRecord } = useRecord<ReceiptDraftDto>(`/receipt-drafts/${id}`);
  const missing = draft?.missingFields ?? [];
  const customerId = draft?.request.customerId ?? null;
  const currency = draft?.request.currency ?? null;
  // The pick lists NOLON gives for the receipt's customer (as the assistant's are): the cash
  // accounts a receipt for them may use, in the receipt's currency once it has one, and their
  // open invoices. Without a customer yet, there is nothing to choose from.
  const query = (extra: string | null) =>
    customerId === null
      ? null
      : `customerId=${encodeURIComponent(customerId)}${extra ? `&currency=${encodeURIComponent(extra)}` : ''}`;
  const cashQuery = missing.includes('cashAccountId') ? query(currency) : null;
  const invoiceQuery = missing.some((f) => f.endsWith('.invoiceId')) ? query(currency) : null;
  const accounts = useOptionalRead<{ items: ReceiptCashAccountDto[] }>(
    cashQuery === null ? null : `/receipt-drafts/cash-accounts?${cashQuery}`,
  );
  const invoices = useOptionalRead<{ items: ReceiptOpenInvoiceDto[] }>(
    invoiceQuery === null ? null : `/receipt-drafts/open-invoices?${invoiceQuery}`,
  );
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const rc = draft.request;
  // A value the draft still misses shows as a dash (MissingFields names it).
  const shown = currency ?? undefined;
  const cashChoices = (accounts?.items ?? []).map((a) => ({
    value: a.id,
    label: `${a.code} · ${name(a)} · ${a.currency}`,
  }));
  const invoiceChoices = (invoices?.items ?? []).map((i) => ({
    value: i.id,
    label: t('openInvoiceChoice', {
      number: i.number ?? '—',
      outstanding: i.outstanding,
      currency: i.currency,
    }),
  }));

  return (
    <DraftFrame
      draft={draft}
      apiPath="/receipt-drafts"
      title={t('receiptTitle', { customer: draft.customerName ?? '—' })}
      approveHint={t('receiptApproveHint')}
      result={
        draft.receiptId
          ? { label: draft.receiptNumber ?? '', href: `/receipts/${draft.receiptId}` }
          : null
      }
      onChanged={setRecord}
    >
      <MissingFields
        draft={draft}
        apiPath="/receipt-drafts"
        choices={{ cashAccountId: cashChoices, invoiceId: invoiceChoices }}
        onChanged={setRecord}
      />
      <dl className="details">
        <dt>{tr('customer')}</dt>
        <dd>{draft.customerName ?? '—'}</dd>
        <dt>{tr('receiptDate')}</dt>
        <dd dir="ltr">{rc.receiptDate ?? '—'}</dd>
        <dt>{tr('amount')}</dt>
        <dd>{rc.amount ? <Money value={rc.amount} currency={shown} /> : '—'}</dd>
        <dt>{tr('cashAccount')}</dt>
        <dd>
          {draft.cashAccountCode ? (
            <>
              <span dir="ltr">{draft.cashAccountCode}</span>{' '}
              {name({
                nameEn: draft.cashAccountNameEn ?? '',
                nameAr: draft.cashAccountNameAr ?? '',
              })}
            </>
          ) : (
            '—'
          )}
        </dd>
        <dt>{tr('reference')}</dt>
        <dd dir="ltr">{rc.reference ?? '—'}</dd>
        <dt>{tc('notes')}</dt>
        <dd>{rc.notes ?? '—'}</dd>
      </dl>
      {rc.allocations.length === 0 ? (
        <p className="muted">{tr('noAllocations')}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{tr('invoice')}</th>
                <th>{tr('allocatedAmount')}</th>
              </tr>
            </thead>
            <tbody>
              {rc.allocations.map((a, i) => {
                const number = draft.invoiceNumbers[i] ?? '—';
                return (
                  <tr key={i}>
                    <td dir="ltr">
                      {number === '—' || !a.invoiceId ? (
                        number
                      ) : (
                        <Link href={`/invoices/${a.invoiceId}`}>{number}</Link>
                      )}
                    </td>
                    <td>{a.amount ? <Money value={a.amount} currency={shown} /> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </DraftFrame>
  );
}
