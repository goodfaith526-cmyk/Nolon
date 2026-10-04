'use client';

import type { CustomerInvoiceDto, CustomerInvoiceSummaryDto, Page } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link, useRouter } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { Notice, type NoticeState, useFailureText } from '../commercial/Notice';
import { can, useMe } from '../StaffShell';
import { StatusBadge } from '../StatusBadge';
import { InvoiceNumber } from './Invoices';
import { Money } from './common';

/** The shipment's customer invoices, and a button that starts a draft prefilled from the quote. */
export function ShipmentInvoices({ shipmentId }: { shipmentId: string }) {
  const t = useTranslations('Invoices');
  const me = useMe();
  const router = useRouter();
  const failure = useFailureText();
  const [invoices, setInvoices] = useState<CustomerInvoiceSummaryDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<Page<CustomerInvoiceSummaryDto>>(`/customer-invoices?shipmentId=${shipmentId}&pageSize=50`)
      .then((page) => {
        if (!cancelled) setInvoices(page.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [shipmentId, failure]);

  async function create() {
    setBusy(true);
    setNotice(null);
    try {
      const draft = await api<CustomerInvoiceDto>('/customer-invoices', {
        method: 'POST',
        body: { shipmentId },
      });
      router.push(`/invoices/${draft.id}/edit`);
    } catch (e) {
      setNotice({ ok: false, text: failure(e) });
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('title')}</h2>
        {can(me, 'customer_invoices:create') && (
          <button type="button" className="primary" disabled={busy} onClick={() => void create()}>
            {t('create')}
          </button>
        )}
      </div>
      {notice && (
        <div className="panel-body">
          <Notice notice={notice} />
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
