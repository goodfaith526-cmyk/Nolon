'use client';

import type { ShipmentInvoiceRefDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { Link } from '@/i18n/navigation';
import { InvoiceNumber } from './Invoices';

/**
 * Before another invoice bills a shipment that has invoices (owner decision Q3): they are listed,
 * and the person ticks that they checked them. The API refuses the new invoice unless the request
 * names exactly these invoices, so a list that changed in between is refused, not passed.
 */
export function OtherInvoicesCheck({
  invoices,
  checked,
  onChange,
  disabled = false,
}: {
  /** The shipment's invoices that are not cancelled. */
  invoices: readonly ShipmentInvoiceRefDto[];
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Invoices');
  const id = useId();
  if (invoices.length === 0) return null;
  return (
    <div className="stack">
      <p className="warning">{t('otherInvoicesWarning', { count: invoices.length })}</p>
      <ul>
        {invoices.map((i) => (
          <li key={i.id}>
            <Link href={`/invoices/${i.id}`}>
              <InvoiceNumber number={i.number} />
            </Link>
          </li>
        ))}
      </ul>
      <label className="field inline" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {t('otherInvoicesConfirm')}
      </label>
    </div>
  );
}
