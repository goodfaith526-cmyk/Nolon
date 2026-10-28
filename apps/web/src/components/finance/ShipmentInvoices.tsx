'use client';

import type { CustomerInvoiceDto, CustomerInvoiceSummaryDto, Page } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { InvoiceNumber } from './Invoices';
import { OtherInvoicesCheck } from './OtherInvoicesCheck';
import { Money } from './common';

/** The shipment's customer invoices, and a button that starts a draft prefilled from the quote. */
export function ShipmentInvoices({ shipmentId }: { shipmentId: string }) {
  const t = useTranslations('Invoices');
  const me = useMe();
  const router = useRouter();
  const failure = useFailureText();
  const [invoices, setInvoices] = useState<CustomerInvoiceSummaryDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  // The invoices another invoice would bill the shipment on top of (Q3).
  const live = (invoices ?? []).filter((i) => i.status !== 'CANCELLED');
  // The tick holds for the list it was given on: once the list read changes, it is asked again,
  // so the ids sent are always the ones the person saw (Codex F116-1).
  const listed = live.map((i) => `${i.id}:${i.status}`).join(',');
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = confirmedFor === listed;
  // Only the latest read is shown: an earlier one answering late is dropped.
  const reads = useRef(0);

  // Every invoice of the shipment, page after page: the API compares the whole list (F116-2).
  const readAll = useCallback(async () => {
    const all: CustomerInvoiceSummaryDto[] = [];
    for (let page = 1; ; page++) {
      const result = await api<Page<CustomerInvoiceSummaryDto>>(
        `/customer-invoices?shipmentId=${shipmentId}&pageSize=100&page=${page}`,
      );
      all.push(...result.items);
      if (result.items.length === 0 || all.length >= result.total) return all;
    }
  }, [shipmentId]);

  /** Shows a read unless a later one started, or the panel went (`active`). */
  const show = useCallback(
    (read: number, active: () => boolean) => {
      const current = () => active() && read === reads.current;
      readAll()
        .then((items) => {
          if (current()) setInvoices(items);
        })
        .catch((e: unknown) => {
          if (current()) setNotice({ ok: false, text: failure(e) });
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    },
    [readAll, failure],
  );

  useEffect(() => {
    let active = true;
    show(++reads.current, () => active);
    return () => {
      active = false;
    };
  }, [show]);

  async function create() {
    setBusy(true);
    setNotice(null);
    try {
      const draft = await api<CustomerInvoiceDto>('/customer-invoices', {
        method: 'POST',
        body: { shipmentId, acknowledgedInvoiceIds: live.map((i) => i.id) },
      });
      router.push(`/invoices/${draft.id}/edit`);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      setBusy(false);
      // The shipment's invoices may have changed meanwhile: read them again, to be checked again.
      setConfirmedFor(null);
      setLoading(true);
      show(++reads.current, () => true);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('title')}</h2>
        {can(me, 'customer_invoices:create') && (
          <button
            type="button"
            className="primary"
            disabled={busy || loading || invoices === null || (live.length > 0 && !confirmed)}
            onClick={() => void create()}
          >
            {t('create')}
          </button>
        )}
      </div>
      {notice && (
        <div className="panel-body">
          <Notice notice={notice} />
        </div>
      )}
      {can(me, 'customer_invoices:create') && live.length > 0 && (
        <div className="panel-body">
          <OtherInvoicesCheck
            invoices={live}
            checked={confirmed}
            onChange={(checked) => setConfirmedFor(checked ? listed : null)}
            disabled={busy || loading}
          />
        </div>
      )}
      {invoices === null ? null : invoices.length === 0 ? (
        <p className="empty">{t('noneForShipment')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('number')}</th>
              <th>{t('invoiceDate')}</th>
              <th>{t('total')}</th>
              <th>{t('balance')}</th>
              <th>{t('status')}</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className={i.status === 'CANCELLED' ? 'inactive' : ''}>
                <td className="nowrap">
                  <Link href={`/invoices/${i.id}`}>
                    <InvoiceNumber number={i.number} />
                  </Link>
                </td>
                <td dir="ltr">{i.invoiceDate}</td>
                <td dir="ltr">
                  <Money value={i.total} currency={i.currency} />
                </td>
                <td dir="ltr">
                  <Money value={i.balance} currency={i.currency} />
                </td>
                <td>
                  <span className="actions">
                    <StatusBadge kind="invoice" status={i.status} />
                    {i.status === 'APPROVED' && (
                      <StatusBadge kind="payment" status={i.paymentStatus} />
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
