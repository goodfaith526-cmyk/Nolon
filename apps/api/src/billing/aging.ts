import { AGING_BUCKETS, type AgingAmountsDto, type AgingBucket } from '@nolon/shared';
import { type Decimal, ZERO } from '../common/money.js';

const DAY_MS = 86_400_000;

/** Whole days from the due date to the report date (YYYY-MM-DD); negative when not yet due. */
export function daysPastDue(asOf: string, dueDate: string): number {
  const at = Date.parse(`${asOf}T00:00:00Z`);
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  return Math.round((at - due) / DAY_MS);
}

/**
 * Aging buckets (annex D, AR aging): not yet due or due on the report date is current; then 1-30,
 * 31-60, 61-90 and over 90 days past the due date.
 */
export function agingBucket(days: number): AgingBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'over90';
}

/** Adds amounts into their buckets; `total` is the sum of every bucket. */
export class AgingTotals {
  private readonly amounts = new Map<AgingBucket, Decimal>(AGING_BUCKETS.map((b) => [b, ZERO]));

  add(bucket: AgingBucket, amount: Decimal): void {
    this.amounts.set(bucket, (this.amounts.get(bucket) ?? ZERO).plus(amount));
  }

  toDto(): AgingAmountsDto {
    let total = ZERO;
    const result = {} as Record<AgingBucket, string>;
    for (const bucket of AGING_BUCKETS) {
      const value = this.amounts.get(bucket) ?? ZERO;
      result[bucket] = value.toFixed();
      total = total.plus(value);
    }
    return { ...result, total: total.toFixed() };
  }
}
