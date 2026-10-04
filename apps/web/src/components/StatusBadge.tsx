'use client';

import { useTranslations } from 'next-intl';

/** A status as a colored pill. The color comes from the status name (globals.css, .badge-*). */
export function StatusBadge({
  kind,
  status,
}: {
  kind:
    | 'rate'
    | 'quotation'
    | 'booking'
    | 'shipment'
    | 'invoice'
    | 'payment'
    | 'journal'
    | 'receipt'
    | 'period';
  status: string;
}) {
  const te = useTranslations('Enums');
  return <span className={`badge badge-${kind} badge-${status}`}>{te(`${kind}_${status}`)}</span>;
}
