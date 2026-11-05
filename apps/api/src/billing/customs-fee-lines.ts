import type { InvoiceKind } from '@nolon/shared';
import type { Decimal } from '../common/money.js';
import { isLiveInvoice } from './live-invoice.js';

// Plan 12 section 5: the shipment's customs fees reach its additional services invoice. Pure, so
// the invoice service, the alert and the tests apply the same rules.

/** The charge type customs fee lines are billed under. */
export const CUSTOMS_FEE_CHARGE = 'CUSTOMS';

export interface FeeInvoice {
  id: string;
  number: string | null;
  kind: InvoiceKind;
  status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  total: Decimal;
  paidAmount: Decimal;
  creditedAmount: Decimal;
  lines: readonly { chargeTypeCode: string; customsFeeId: string | null }[];
}

export interface ShipmentFee {
  id: string;
  description: string;
  currency: string;
  createdAt: Date;
}

/**
 * The fees no live invoice of the shipment bills (other than `exceptInvoiceId`, the one being
 * written), oldest first. None while a live MAIN invoice bills the charge CUSTOMS: its agreed
 * price covers customs, and the charge cannot also be on an additional invoice (ب3 rule 3).
 */
export function unbilledFees<F extends ShipmentFee>(
  fees: readonly F[],
  invoices: readonly FeeInvoice[],
  exceptInvoiceId: string | null = null,
): F[] {
  const live = invoices.filter((i) => i.id !== exceptInvoiceId && isLiveInvoice(i));
  if (
    live.some(
      (i) => i.kind === 'MAIN' && i.lines.some((l) => l.chargeTypeCode === CUSTOMS_FEE_CHARGE),
    )
  )
    return [];
  const billed = new Set(
    live.flatMap((i) => i.lines.flatMap((l) => (l.customsFeeId ? [l.customsFeeId] : []))),
  );
  return fees
    .filter((f) => !billed.has(f.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/**
 * The currency an additional services invoice is made in to bill `fees`: theirs when they all
 * share one, else `fallback` (the invoice's usual currency), whose fees alone are then offered.
 */
export function feesCurrency(fees: readonly ShipmentFee[], fallback: string): string {
  const currencies = new Set(fees.map((f) => f.currency));
  return currencies.size === 1 ? fees[0]!.currency : fallback;
}

/** The first fee its lines cannot bill as they are, or null when every one can. */
export function feeLinesProblem(input: {
  kind: InvoiceKind;
  currency: string;
  lines: readonly { chargeTypeCode: string; customsFeeId: string | null }[];
  /** The shipment's fees named by the lines (a missing one is not the shipment's). */
  fees: readonly ShipmentFee[];
}): string | null {
  const seen = new Set<string>();
  for (const line of input.lines) {
    const id = line.customsFeeId;
    if (id === null) continue;
    const fee = input.fees.find((f) => f.id === id);
    if (
      seen.has(id) ||
      fee === undefined ||
      input.kind !== 'ADDITIONAL' ||
      line.chargeTypeCode !== CUSTOMS_FEE_CHARGE ||
      fee.currency !== input.currency
    )
      return id;
    seen.add(id);
  }
  return null;
}
