import type {
  CycleTimeDto,
  ProfitCategoryDto,
  ProfitFiguresDto,
  ProfitIncompleteReason,
  RateUnit,
  ReportCountryDto,
  ReportLocationDto,
} from '@nolon/shared';
import { type Decimal, ZERO, dec, roundMoney } from '../common/money.js';

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
  salesOutlet: { id: string; name: string } | null;
  originCountry: ReportCountryDto;
  category: ProfitCategoryDto;
  /** A single category's unit; null for MIXED and UNSPECIFIED. */
  unit: RateUnit | null;
  /** The shipment's units in `unit`; null when a line lacks the measure (or no single unit). */
  units: Decimal | null;
  incompleteReasons: readonly ProfitIncompleteReason[];
  cycleDays: Decimal | null;
}

export interface Rollup<K> extends ProfitAmounts {
  key: K;
  shipments: number;
  /** Shipments whose figures are not final yet (plan 6.2): the totals include them. */
  incompleteShipments: number;
}

/** Adds shipments up by a key, keeping the first shipment's key object. Order of first sight. */
export function rollUp<K>(
  shipments: readonly ShipmentAmounts[],
  keyOf: (s: ShipmentAmounts) => { id: string; key: K },
): Rollup<K>[] {
  const groups = new Map<string, Rollup<K>>();
  for (const s of shipments) {
    const { id, key } = keyOf(s);
    const group = groups.get(id) ?? { key, shipments: 0, incompleteShipments: 0, ...NO_AMOUNTS };
    const amounts = addAmounts(group, s);
    groups.set(id, {
      ...group,
      ...amounts,
      shipments: group.shipments + 1,
      incompleteShipments: group.incompleteShipments + (s.incompleteReasons.length > 0 ? 1 : 0),
    });
  }
  return [...groups.values()];
}

/** Every shipment as one group: the report's totals. */
export function totalOf(shipments: readonly ShipmentAmounts[]): Rollup<null> {
  return (
    rollUp(shipments, () => ({ id: '', key: null }))[0] ?? {
      key: null,
      shipments: 0,
      incompleteShipments: 0,
      ...NO_AMOUNTS,
    }
  );
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

/** Shipments without an outlet roll up together, as "unspecified". */
export function byOutlet(shipments: readonly ShipmentAmounts[]) {
  return rollUp(shipments, (s) => ({
    id: s.salesOutlet?.id ?? '',
    key: { salesOutlet: s.salesOutlet },
  }));
}

export function byOriginCountry(shipments: readonly ShipmentAmounts[]) {
  return rollUp(shipments, (s) => ({
    id: s.originCountry.code,
    key: { originCountry: s.originCountry },
  }));
}

/** Days are shown to 1 decimal place. */
const DAY_DECIMALS = 1;
const MS_PER_DAY = 86_400_000;

/**
 * The category a shipment counts under (plan 6.3): its lines' one category, MIXED for more than
 * one, UNSPECIFIED when any line has none (or there are no lines). A shipment is never split.
 */
export function shipmentCategory(
  lines: readonly { category: { code: string; nameEn: string; nameAr: string } | null }[],
): ProfitCategoryDto {
  if (lines.length === 0 || lines.some((l) => !l.category)) return { kind: 'UNSPECIFIED' };
  const codes = new Set(lines.map((l) => l.category?.code));
  const first = lines[0]?.category;
  if (codes.size > 1 || !first) return { kind: 'MIXED' };
  return { kind: 'SINGLE', ...first };
}

/** The lines' measure in a category's unit; null when a line lacks it. Whole shipments count 1. */
export function unitsIn(
  unit: RateUnit,
  lines: readonly { quantity: number; volumeCbm: Decimal | null; weightKg: Decimal | null }[],
): Decimal | null {
  if (unit === 'PER_SHIPMENT') return dec(1);
  let total = ZERO;
  for (const line of lines) {
    const measure =
      unit === 'PER_CBM' ? line.volumeCbm : unit === 'PER_KG' ? line.weightKg : dec(line.quantity);
    if (!measure) return null;
    total = total.plus(measure);
  }
  return total;
}

/**
 * Per category, each shipment in exactly one column, so the columns add up to the report's totals
 * exactly. Margin per unit only for a single category whose every shipment has its units.
 */
export function byCategory(shipments: readonly ShipmentAmounts[]) {
  const groups = rollUp(shipments, (s) => ({
    id: s.category.kind === 'SINGLE' ? `SINGLE:${s.category.code}` : s.category.kind,
    key: { category: s.category, unit: s.unit },
  }));
  return groups.map((g) => {
    const members = shipments.filter((s) => sameCategory(s.category, g.key.category));
    let units: Decimal | null = g.key.unit ? ZERO : null;
    for (const s of members) units = units && s.units ? units.plus(s.units) : null;
    return { ...g, units: units && units.gt(0) ? units : null };
  });
}

function sameCategory(a: ProfitCategoryDto, b: ProfitCategoryDto): boolean {
  if (a.kind === 'SINGLE' && b.kind === 'SINGLE') return a.code === b.code;
  return a.kind === b.kind;
}

/** Margin per unit, to the cent; null without units. */
export function marginPerUnit(amounts: ProfitAmounts, units: Decimal | null): string | null {
  if (!units) return null;
  return roundMoney(amounts.revenueUsd.minus(amounts.costUsd).div(units), 2).toFixed();
}

/** Days between two instants, exact (rounded only for display). */
export function daysBetween(from: Date, to: Date): Decimal {
  return dec(to.getTime() - from.getTime()).div(MS_PER_DAY);
}

export function showDays(days: Decimal | null): string | null {
  return days ? roundMoney(days, DAY_DECIMALS).toFixed() : null;
}

/** Cycle time over the shipments that have one. */
export function cycleTime(days: readonly (Decimal | null)[]): CycleTimeDto {
  const measured = days.filter((d): d is Decimal => d !== null);
  if (measured.length === 0) {
    return { measured: 0, averageDays: null, minDays: null, maxDays: null };
  }
  const total = measured.reduce((a, b) => a.plus(b), ZERO);
  const sorted = [...measured].sort((a, b) => a.comparedTo(b));
  return {
    measured: measured.length,
    averageDays: showDays(total.div(measured.length)),
    minDays: showDays(sorted[0] ?? null),
    maxDays: showDays(sorted.at(-1) ?? null),
  };
}

/**
 * Why a shipment's figures may not be final (plan 6.2): revenue without any cost, an open
 * transport accrual on one of its trips, or the shipment not closed (a cancelled one is final).
 */
export function incompleteReasons(input: {
  amounts: ProfitAmounts;
  openAccrual: boolean;
  status: string;
}): ProfitIncompleteReason[] {
  const reasons: ProfitIncompleteReason[] = [];
  if (input.amounts.revenueUsd.gt(0) && input.amounts.costUsd.isZero()) reasons.push('NO_COST');
  if (input.openAccrual) reasons.push('OPEN_ACCRUAL');
  if (input.status !== 'CLOSED' && input.status !== 'CANCELLED') reasons.push('NOT_CLOSED');
  return reasons;
}
