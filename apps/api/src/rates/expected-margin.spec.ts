import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  type MarginCommission,
  type MarginCost,
  type MarginInput,
  computeExpectedMargin,
} from './expected-margin.js';

const notApplicable = (component: MarginCost['component']): MarginCost => ({
  component,
  status: 'NOT_APPLICABLE',
  amount: null,
  currency: null,
  unit: null,
  unitsPerCostUnit: null,
  conversionCardUnit: null,
});
const entered = (
  component: MarginCost['component'],
  amount: string,
  unit: MarginCost['unit'],
  extra: Partial<MarginCost> = {},
): MarginCost => ({
  component,
  status: 'ENTERED',
  amount: dec(amount),
  currency: 'USD',
  unit,
  unitsPerCostUnit: null,
  conversionCardUnit: null,
  ...extra,
});
const percent = (value: string): MarginCommission => ({
  kind: 'CONTRACT',
  contract: { basis: 'PERCENT_OF_PRICE', value: dec(value), unit: null, currency: null },
});

/** A PER_PIECE card at 100 USD, every cost not applicable, a 0% commission, unless overridden. */
function margin(overrides: Partial<MarginInput> = {}) {
  const result = computeExpectedMargin({
    card: { unit: 'PER_PIECE', price: dec(100), minimumCharge: dec(0), currency: 'USD' },
    costs: [
      notApplicable('ORIGIN_HANDLING'),
      notApplicable('SEA_FREIGHT'),
      notApplicable('DISTRIBUTION'),
      notApplicable('OTHER'),
    ],
    commission: percent('0'),
    quantity: null,
    fxRate: (currency) => ({ USD: dec(1), SAR: dec('3.75') })[currency] ?? null,
    decimalPlaces: 2,
    ...overrides,
  });
  return {
    ...result,
    margin: result.expectedMargin?.toFixed() ?? null,
    line: (component: string) => result.lines.find((l) => l.component === component),
  };
}

const withCost = (cost: MarginCost) =>
  [
    notApplicable('ORIGIN_HANDLING'),
    notApplicable('SEA_FREIGHT'),
    notApplicable('DISTRIBUTION'),
    notApplicable('OTHER'),
  ].map((c) => (c.component === cost.component ? cost : c));

describe('computeExpectedMargin', () => {
  it('does not subtract a container cost from a piece price without a conversion', () => {
    const r = margin({ costs: withCost(entered('SEA_FREIGHT', '1000', 'PER_CONTAINER')) });
    expect(r.margin).toBeNull();
    expect(r.missing).toEqual(['SEA_FREIGHT']);
    expect(r.line('SEA_FREIGHT')?.gap).toBe('UNIT_NOT_CONVERTIBLE');
  });

  it('spreads a container cost over the pieces a container holds', () => {
    const r = margin({
      costs: withCost(
        entered('SEA_FREIGHT', '1000', 'PER_CONTAINER', {
          unitsPerCostUnit: dec(400),
          conversionCardUnit: 'PER_PIECE',
        }),
      ),
    });
    expect(r.line('SEA_FREIGHT')?.amount?.toFixed()).toBe('2.5');
    expect(r.margin).toBe('97.5');
  });

  it('drops a factor entered for another card unit: 400 pieces a container is not 400 CBM', () => {
    const r = margin({
      costs: withCost(
        entered('SEA_FREIGHT', '1000', 'PER_CONTAINER', {
          unitsPerCostUnit: dec(400),
          conversionCardUnit: 'PER_CBM',
        }),
      ),
    });
    expect(r.margin).toBeNull();
    expect(r.line('SEA_FREIGHT')?.gap).toBe('UNIT_NOT_CONVERTIBLE');
  });

  it('needs the pieces of a reference shipment for a per-shipment cost', () => {
    expect(margin({ costs: withCost(entered('OTHER', '50', 'PER_SHIPMENT')) }).missing).toEqual([
      'OTHER',
    ]);
  });

  it('is incomplete, naming the component, until every cost is entered or not applicable', () => {
    const r = margin({ costs: withCost(notApplicable('OTHER')).slice(1) });
    expect(r).toMatchObject({ margin: null, missing: ['ORIGIN_HANDLING'] });
    expect(r.line('ORIGIN_HANDLING')?.gap).toBe('NOT_ENTERED');
  });

  it('counts a zero only when a zero is entered', () => {
    const r = margin({ costs: withCost(entered('DISTRIBUTION', '0', 'PER_PIECE')) });
    expect(r.margin).toBe('100');
    expect(r.line('DISTRIBUTION')).toMatchObject({ notApplicable: false, gap: null });
  });

  it('converts a cost in another currency at the day’s rates, or is incomplete without one', () => {
    const sar = entered('ORIGIN_HANDLING', '37.5', 'PER_PIECE', { currency: 'SAR' });
    expect(margin({ costs: withCost(sar) }).margin).toBe('90');
    const aed = entered('ORIGIN_HANDLING', '10', 'PER_PIECE', { currency: 'AED' });
    const r = margin({ costs: withCost(aed) });
    expect(r.margin).toBeNull();
    expect(r.line('ORIGIN_HANDLING')?.gap).toBe('NO_FX_RATE');
  });

  it('takes a percentage commission of the price, in Decimal', () => {
    const r = margin({
      card: { unit: 'PER_PIECE', price: dec('33.33'), minimumCharge: dec(0), currency: 'USD' },
      commission: percent('7.5'),
    });
    expect(r.line('OUTLET_COMMISSION')?.amount?.toFixed()).toBe('2.5');
    // 33.33 - 2.49975, rounded once.
    expect(r.margin).toBe('30.83');
  });

  it('pays no commission on a shipment sold without an outlet (plan 6.2)', () => {
    const r = margin({ commission: { kind: 'DIRECT' } });
    expect(r.line('OUTLET_COMMISSION')).toMatchObject({ notApplicable: true, gap: null });
    expect(r.margin).toBe('100');
    expect(r.missing).toEqual([]);
  });

  it('prices a reference quantity under the minimum at the minimum, commission included', () => {
    const r = margin({
      card: { unit: 'PER_PIECE', price: dec(100), minimumCharge: dec(500), currency: 'USD' },
      costs: withCost(entered('DISTRIBUTION', '10', 'PER_PIECE')),
      commission: percent('10'),
      quantity: dec(3),
    });
    expect(r.price.toFixed()).toBe('500');
    expect(r.line('OUTLET_COMMISSION')?.amount?.toFixed()).toBe('50');
    expect(r.line('DISTRIBUTION')?.amount?.toFixed()).toBe('30');
    expect(r.margin).toBe('420');
  });

  it('leaves out the minimum for one unit', () => {
    const r = margin({
      card: { unit: 'PER_PIECE', price: dec(100), minimumCharge: dec(500), currency: 'USD' },
    });
    expect(r.price.toFixed()).toBe('100');
  });

  it('takes a fixed commission per unit only in the card’s unit', () => {
    const fixed = (unit: MarginCost['unit'], currency = 'USD'): MarginCommission => ({
      kind: 'CONTRACT',
      contract: { basis: 'FIXED_PER_UNIT', value: dec(4), unit, currency },
    });
    expect(margin({ commission: fixed('PER_PIECE'), quantity: dec(2) }).margin).toBe('192');
    const other = margin({ commission: fixed('PER_KG') });
    expect(other.margin).toBeNull();
    expect(other.line('OUTLET_COMMISSION')?.gap).toBe('UNIT_NOT_CONVERTIBLE');
    expect(
      margin({ commission: fixed('PER_PIECE', 'SAR') })
        .line('OUTLET_COMMISSION')
        ?.amount?.toFixed(),
    ).toBe('1.07');
  });

  it('is incomplete until an outlet with a contract is chosen', () => {
    expect(margin({ commission: { kind: 'NO_OUTLET' } }).line('OUTLET_COMMISSION')?.gap).toBe(
      'OUTLET_NOT_CHOSEN',
    );
    const r = margin({ commission: { kind: 'NO_CONTRACT' } });
    expect(r).toMatchObject({ margin: null, missing: ['OUTLET_COMMISSION'] });
  });
});
