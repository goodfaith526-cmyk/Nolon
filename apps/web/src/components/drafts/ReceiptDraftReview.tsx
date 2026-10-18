'use client';

import type { AccountDto, ReceiptDraftDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useLocalName } from '@/lib/master-data';
import { Notice } from '../commercial/Notice';
import { Money, useRecord } from '../finance/common';
import { useApiList } from '../finance/reports/ReportKit';
import { DraftFrame } from './DraftFrame';
import { MissingFields } from './MissingFields';

/** A receipt the assistant proposed: the amount, the cash account and the invoices it settles. */
export function ReceiptDraftReview({ id }: { id: string }) {
  const t = useTranslations('Drafts');
  const tr = useTranslations('Receipts');
  const tc = useTranslations('Common');
  const name = useLocalName();
  const { record: draft, notice, setRecord } = useRecord<ReceiptDraftDto>(`/receipt-drafts/${id}`);
  const needsCash = draft?.missingFields.includes('cashAccountId') ?? false;
  const accounts = useApiList<AccountDto>('/accounting/accounts', needsCash);
  if (notice) return <Notice notice={notice} />;
  if (!draft) return <p className="muted">{tc('loading')}</p>;
  const rc = draft.request;
  // A value the draft still misses shows as a dash (MissingFields names it).
  const currency = rc.currency ?? undefined;
  const cashChoices = (accounts ?? [])
    .filter(
      (a) =>
        a.isCash &&
        a.isActive &&
        a.isPostable &&
        (a.branchId === null || a.branchId === draft.branchId) &&
        (currency === undefined || a.currency === currency),
    )
    .map((a) => ({ value: a.id, label: `${a.code} · ${name(a)}` }));

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
        choices={{ cashAccountId: cashChoices }}
        onChanged={setRecord}
      />
      <dl className="details">
        <dt>{tr('customer')}</dt>
        <dd>{draft.customerName ?? '—'}</dd>
        <dt>{tr('receiptDate')}</dt>
        <dd dir="ltr">{rc.receiptDate ?? '—'}</dd>
        <dt>{tr('amount')}</dt>
        <dd>{rc.amount ? <Money value={rc.amount} currency={currency} /> : '—'}</dd>
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
                    <td>{a.amount ? <Money value={a.amount} currency={currency} /> : '—'}</td>
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
