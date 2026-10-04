import type { ArAgingDto } from '@nolon/shared';
import { type Decimal, ZERO, dec } from '../common/money.js';
import type { InvoiceAging } from '../billing/billing-reports.service.js';

const NO_AMOUNTS = {
  current: '0',
  days1to30: '0',
  days31to60: '0',
  days61to90: '0',
  over90: '0',
  total: '0',
};

/**
 * Adds each customer's unapplied advances (the credit side) to the invoice aging: an advances
 * column and a net column (open invoices less advances). Customers with only an advance are
 * listed too. Customers are sorted by name.
 */
export function withAdvances(
  aging: InvoiceAging,
  advances: readonly { customerId: string; customerName: string; amountUsd: Decimal }[],
): ArAgingDto {
  const byCustomer = new Map(advances.map((a) => [a.customerId, a]));
  const customers = aging.customers.map((c) => {
    const advance = byCustomer.get(c.customerId)?.amountUsd ?? ZERO;
    byCustomer.delete(c.customerId);
    return {
      ...c,
      advancesUsd: advance.toFixed(),
      netUsd: dec(c.amounts.total).minus(advance).toFixed(),
    };
  });
  for (const a of byCustomer.values()) {
    customers.push({
      customerId: a.customerId,
      customerName: a.customerName,
      amounts: { ...NO_AMOUNTS },
      advancesUsd: a.amountUsd.toFixed(),
      netUsd: a.amountUsd.negated().toFixed(),
    });
  }
  customers.sort((a, b) => a.customerName.localeCompare(b.customerName));
  const totalAdvances = advances.reduce((sum, a) => sum.plus(a.amountUsd), ZERO);
  return {
    ...aging,
    customers,
    totalAdvancesUsd: totalAdvances.toFixed(),
    netUsd: dec(aging.totals.total).minus(totalAdvances).toFixed(),
  };
}
