import { BASE_CURRENCY } from '@nolon/shared';
import { type Decimal, ZERO, dec, roundMoney } from '../common/money.js';

// Client decision ب6 (docs/plans/06-client-decisions-v2.md): a customer's open balance against
// the credit limit. Pure, so the service reads everything in one statement and decides here.

/** What the single statement read (creditSnapshotSql), as text so no amount passes a JS number. */
export interface CreditSnapshotRow {
  limit: string | null;
  limitCurrency: string | null;
  /** Minor units of the limit's currency. */
  limitDecimals: number | null;
  /** Left to pay on approved invoices, per currency (positive). */
  invoices: readonly { currency: string; amount: string }[];
  /** Unapplied advances of posted receipts, per currency (positive: they lower the balance). */
  advances: readonly { currency: string; amount: string }[];
  /** The latest rate on or before today of every currency involved: units per 1 USD. */
  rates: readonly { currency: string; rate: string }[];
}

export type CreditPosition =
  | { kind: 'NO_LIMIT' }
  | { kind: 'NO_RATE'; currency: string }
  | {
      kind: 'WITHIN' | 'EXCEEDED';
      /** The open balance in the limit's currency, rounded once to its minor units. */
      balance: Decimal;
      limit: Decimal;
      currency: string;
    };

/**
 * The open balance in the limit's currency: what is left to pay on approved invoices, less
 * unapplied advances, each converted at the latest rate (amount / rate × limit rate; USD is 1).
 * A customer with no limit is not checked. A rate missing for any currency that must be converted
 * gives NO_RATE: the check is never passed for want of data. Over the limit is strictly greater.
 */
export function creditPosition(row: CreditSnapshotRow): CreditPosition {
  if (row.limit === null || row.limitCurrency === null) return { kind: 'NO_LIMIT' };
  const target = row.limitCurrency;
  const rates = new Map(row.rates.map((r) => [r.currency, dec(r.rate)]));
  const rateOf = (currency: string): Decimal | null =>
    currency === BASE_CURRENCY ? dec(1) : (rates.get(currency) ?? null);
  let balance = ZERO;
  const parts = [
    ...row.invoices.map((p) => ({ currency: p.currency, amount: dec(p.amount) })),
    ...row.advances.map((p) => ({ currency: p.currency, amount: dec(p.amount).negated() })),
  ];
  for (const part of parts) {
    if (part.amount.isZero()) continue;
    if (part.currency === target) {
      balance = balance.plus(part.amount);
      continue;
    }
    const from = rateOf(part.currency);
    const to = rateOf(target);
    if (from === null || !from.gt(0)) return { kind: 'NO_RATE', currency: part.currency };
    if (to === null || !to.gt(0)) return { kind: 'NO_RATE', currency: target };
    balance = balance.plus(part.amount.div(from).times(to));
  }
  const rounded = roundMoney(balance, row.limitDecimals ?? 2);
  const limit = dec(row.limit);
  return {
    kind: rounded.gt(limit) ? 'EXCEEDED' : 'WITHIN',
    balance: rounded,
    limit,
    currency: target,
  };
}

/** Plan 12 section 3: the shipment's side of the handover gate, read in the credit statement. */
export interface HandoverShipmentRow {
  /** Live approved MAIN invoices of the shipment (approved, not fully credited). */
  mainApproved: number;
  /** Left to pay on the shipment's live approved invoices (MAIN and ADDITIONAL), per currency. */
  shipmentOpen: readonly { currency: string; amount: string }[];
}

export type HandoverDecision =
  | { kind: 'OK' }
  | { kind: 'HANDOVER_NOT_INVOICED' }
  | { kind: 'HANDOVER_UNPAID'; balance: Decimal; currency: string }
  | { kind: 'HANDOVER_OVER_LIMIT'; limit: Decimal; currency: string }
  | { kind: 'CREDIT_LIMIT_NO_RATE'; currency: string };

/**
 * Plan 12 section 3, the handover gate on the current state. (a) A live approved MAIN invoice
 * bills the shipment. (b) Without a limit, or a limit of 0 (cash): nothing is left to pay on the
 * shipment's live approved invoices (an unapplied advance does not count). A positive limit: the
 * customer's open balance is within it (plan 06's position; a missing rate refuses).
 */
export function handoverDecision(row: CreditSnapshotRow & HandoverShipmentRow): HandoverDecision {
  if (row.mainApproved === 0) return { kind: 'HANDOVER_NOT_INVOICED' };
  if (row.limit === null || row.limitCurrency === null || dec(row.limit).isZero()) {
    const unpaid = row.shipmentOpen.find((p) => dec(p.amount).gt(0));
    return unpaid
      ? { kind: 'HANDOVER_UNPAID', balance: dec(unpaid.amount), currency: unpaid.currency }
      : { kind: 'OK' };
  }
  const position = creditPosition(row);
  if (position.kind === 'NO_RATE')
    return { kind: 'CREDIT_LIMIT_NO_RATE', currency: position.currency };
  if (position.kind === 'EXCEEDED') {
    return { kind: 'HANDOVER_OVER_LIMIT', limit: position.limit, currency: position.currency };
  }
  return { kind: 'OK' };
}
