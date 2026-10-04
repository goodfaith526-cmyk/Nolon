import type { ProfitFiguresDto, ReportLocationDto } from '@nolon/shared';
import { type Decimal, ZERO, roundMoney } from '../common/money.js';

/** Revenue and cost in USD, as added up from the journal. */
export interface ProfitAmounts {
  revenueUsd: Decimal;
  costUsd: Decimal;
}

/** Margin percentages are shown to 2 decimal places. */
const PERCENT_DECIMALS = 2;

/** Margin = revenue - cost; margin % = margin / revenue x 100 (null without revenue). */
export function profitFigures({ revenueUsd, costUsd }: ProfitAmounts): ProfitFiguresDto {
  const margin = revenueUsd.minus(costUsd);
  return {
    revenueUsd: revenueUsd.toFixed(),
    costUsd: costUsd.toFixed(),
    marginUsd: margin.toFixed(),
    marginPercent: revenueUsd.isZero()
      ? null
      : roundMoney(margin.div(revenueUsd).times(100), PERCENT_DECIMALS).toFixed(),
  };
}

export function addAmounts(a: ProfitAmounts, b: ProfitAmounts): ProfitAmounts {
  return { revenueUsd: a.revenueUsd.plus(b.revenueUsd), costUsd: a.costUsd.plus(b.costUsd) };
}

export const NO_AMOUNTS: ProfitAmounts = { revenueUsd: ZERO, costUsd: ZERO };

/** A shipment's amounts with what it rolls up by. */
export interface ShipmentAmounts extends ProfitAmounts {
  customerId: string;
  customerName: string;
  origin: ReportLocationDto;
  destination: ReportLocationDto;
}

export interface Rollup<K> extends ProfitAmounts {
  key: K;
  shipments: number;
}

/** Adds shipments up by a key, keeping the first shipment's key object. Order of first sight. */
export function rollUp<K>(
  shipments: readonly ShipmentAmounts[],
  keyOf: (s: ShipmentAmounts) => { id: string; key: K },
): Rollup<K>[] {
  const groups = new Map<string, Rollup<K>>();
  for (const s of shipments) {
    const { id, key } = keyOf(s);
    const group = groups.get(id) ?? { key, shipments: 0, ...NO_AMOUNTS };
    const amounts = addAmounts(group, s);
    groups.set(id, { ...group, ...amounts, shipments: group.shipments + 1 });
  }
  return [...groups.values()];
}

export function byCustomer(shipments: readonly ShipmentAmounts[]) {
  return rollUp(shipments, (s) => ({
    id: s.customerId,
    key: { customerId: s.customerId, customerName: s.customerName },
  }));
}

export function byRoute(shipments: readonly ShipmentAmounts[]) {
  return rollUp(shipments, (s) => ({
    id: `${s.origin.id}>${s.destination.id}`,
    key: { origin: s.origin, destination: s.destination },
  }));
}
