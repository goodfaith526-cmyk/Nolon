'use client';

import type { CustomerCreditDto } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/money';

/**
 * A customer's credit position (client decision ب6), read from the API, which decides; screens
 * only show it and grey the button that the server would refuse. Null while loading, when `path`
 * is null (nothing to ask), or when the read fails (the button stays, the server still refuses).
 */
export function useCustomerCredit(
  customerId: string | null,
  invoiceId: string | null = null,
  version = 0,
): CustomerCreditDto | null {
  const [read, setRead] = useState<{ key: string; credit: CustomerCreditDto } | null>(null);
  const path = customerId
    ? `/customer-credit/${customerId}${invoiceId ? `?invoiceId=${invoiceId}` : ''}`
    : null;
  const key = `${path ?? ''}#${version}`;
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api<CustomerCreditDto>(path)
      .then((credit) => {
        if (!cancelled) setRead({ key, credit });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path, key]);
  // Only the answer to the current question: none while another one loads.
  return path && read?.key === key ? read.credit : null;
}

/** Why the server would refuse a confirmation or approval for this position, or null. */
export function useCreditBlock(): (
  credit: CustomerCreditDto | null,
  customer: string,
) => string | null {
  const tr = useTranslations('Refusals');
  return (credit, customer) => {
    if (credit?.state === 'EXCEEDED') {
      return tr('CREDIT_LIMIT_EXCEEDED', {
        customer,
        limit: formatAmount(credit.limit ?? '0'),
        currency: credit.currency ?? '',
      });
    }
    if (credit?.state === 'NO_RATE') {
      return tr('CREDIT_LIMIT_NO_RATE', { customer, currency: credit.missingRateCurrency ?? '' });
    }
    return null;
  };
}
