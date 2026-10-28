import type { Decimal } from '../common/money.js';
import type { InvoiceStatus } from '@nolon/shared';

/**
 * Whether an invoice still bills its shipment, so the shipment cannot be cancelled (annex B; owner
 * decision Q2, docs/reviews/operations-scenarios-2026-10-27.md). A draft does until it is
 * cancelled. An approved invoice does unless approved credit notes cover all of it and it took no
 * payment: a partial credit leaves it billing, and a paid or part-paid invoice keeps blocking
 * (giving the money back is a separate design).
 */
export function isLiveInvoice(invoice: {
  status: InvoiceStatus;
  total: Decimal;
  paidAmount: Decimal;
  creditedAmount: Decimal;
}): boolean {
  switch (invoice.status) {
    case 'DRAFT':
      return true;
    case 'CANCELLED':
      return false;
    case 'APPROVED':
      return !(invoice.paidAmount.isZero() && invoice.creditedAmount.gte(invoice.total));
  }
}
