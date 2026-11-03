import type { BreakEvenDto } from '@nolon/shared';
import { type Decimal, ZERO, roundMoney } from '../common/money.js';

/** A shipment's period figures, as the profitability report gives them. */
export interface BreakEvenShipment {
  revenueUsd: Decimal;
  costUsd: Decimal;
  incomplete: boolean;
}

/** The average margin is shown to 2 decimal places; the break-even uses the exact average. */
const AVERAGE_DECIMALS = 2;

/**
 * Break-even (plan 07, z5): contribution margin = revenue - cost of every shipment of the period;
 * average = margin / shipments with revenue; break-even = fixed expenses / average, rounded up.
 * No figure when the average is not positive (no fake number).
 */
export function breakEven(
  shipments: readonly BreakEvenShipment[],
  fixedUsd: Decimal,
): BreakEvenDto {
  const margin = shipments.reduce((sum, s) => sum.plus(s.revenueUsd).minus(s.costUsd), ZERO);
  const withRevenue = shipments.filter((s) => s.revenueUsd.gt(0)).length;
  const average = withRevenue > 0 ? margin.div(withRevenue) : null;
  return {
    contributionMarginUsd: margin.toFixed(),
    shipmentsWithRevenue: withRevenue,
    averageMarginUsd: average && roundMoney(average, AVERAGE_DECIMALS).toFixed(),
    fixedExpensesUsd: fixedUsd.toFixed(),
    breakEvenShipments:
      average && average.gt(0)
        ? fixedUsd.gt(0)
          ? fixedUsd.div(average).ceil().toNumber()
          : 0
        : null,
    incompleteShipments: shipments.filter((s) => s.incomplete).length,
  };
}
