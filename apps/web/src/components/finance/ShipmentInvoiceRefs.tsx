'use client';

import type { ShipmentInvoiceRefDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { InvoiceKindLabel, InvoiceNumber } from './Invoices';

/**
 * A shipment's invoices that are not cancelled, listed before a person approves an invoice draft
 * for it. The draft becomes the shipment's main invoice; the API refuses it while the shipment has
 * a live main invoice (client decision ب3).
 */
export function ShipmentInvoiceRefs({ invoices }: { invoices: readonly ShipmentInvoiceRefDto[] }) {
  const t = useTranslations('Invoices');
  if (invoices.length === 0) return null;
  return (
    <div className="stack">
      <p className="warning">{t('shipmentHasInvoices', { count: invoices.length })}</p>
      <ul>
        {invoices.map((i) => (
          <li key={i.id}>
            <Link href={`/invoices/${i.id}`}>
              <InvoiceNumber number={i.number} />
            </Link>{' '}
            <InvoiceKindLabel kind={i.kind} />
          </li>
        ))}
      </ul>
    </div>
  );
}
