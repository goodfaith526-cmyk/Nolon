import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import {
  type AgreedLine,
  type AgreedTermsInput,
  agreedTermsHash,
  agreedTermsReconciled,
} from './agreed-terms.js';

const line = (over: Partial<AgreedLine> = {}): AgreedLine => ({
  id: '11111111-1111-4111-8111-111111111111',
  lineNo: 1,
  cargoType: 'BARREL',
  priceCategoryCode: 'BARREL_STD',
  quantity: 1,
  weightKg: dec('10'),
  volumeCbm: dec('1'),
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  containerTypeCode: null,
  description: null,
  ...over,
});

const terms = (
  items: AgreedLine[] = [line()],
  over: Partial<AgreedTermsInput['booking']> = {},
  quotationLines: AgreedTermsInput['quotation']['lines'] = [
    {
      lineNo: 1,
      chargeTypeCode: 'FREIGHT',
      unit: 'PER_BARREL',
      quantity: dec('1'),
      unitPrice: dec('100'),
      lineTotal: dec('100'),
      containerTypeCode: null,
      bookingItemId: '11111111-1111-4111-8111-111111111111',
      coversAllItems: false,
    },
  ],
): AgreedTermsInput => ({
  booking: {
    originLocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    destinationLocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    mode: 'SEA',
    loadType: 'LCL',
    cargoType: 'BARREL',
    services: ['MAIN_FREIGHT'],
    items,
    ...over,
  },
  quotation: {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    updatedAt: new Date('2026-11-04T10:00:00.000Z'),
    currency: 'USD',
    lines: quotationLines,
  },
});

const estimate: AgreedTermsInput['quotation']['lines'] = [
  {
    lineNo: 1,
    chargeTypeCode: 'FREIGHT',
    unit: 'PER_SHIPMENT',
    quantity: dec('1'),
    unitPrice: dec('450'),
    lineTotal: dec('450'),
    containerTypeCode: null,
    bookingItemId: null,
    coversAllItems: true,
  },
];

describe('agreedTermsHash (plan 12 section 1, Codex F190-2)', () => {
  const base = agreedTermsHash(terms());

  it('is the same for the same terms, decimals written either way', () => {
    expect(agreedTermsHash(terms([line({ weightKg: dec('10.000'), volumeCbm: dec('1.0') })]))).toBe(
      base,
    );
  });

  it('changes when one barrel becomes two', () => {
    expect(agreedTermsHash(terms([line({ quantity: 2 })]))).not.toBe(base);
  });

  it.each([
    ['the CBM (1 → 2)', { volumeCbm: dec('2') }],
    ['the weight (10 → 20 kg)', { weightKg: dec('20') }],
    ['a dimension', { lengthCm: dec('120') }],
    ['the container type', { containerTypeCode: '20GP' }],
    ['the price category', { priceCategoryCode: 'BARREL_BIG' }],
    ['the description', { description: 'Sofa' }],
  ])('changes with the same piece count when %s changes', (_, change) => {
    expect(agreedTermsHash(terms([line(change)]))).not.toBe(base);
  });

  it('changes when a line is added in the same category, or dropped', () => {
    const second = line({ id: '22222222-2222-4222-8222-222222222222', lineNo: 2 });
    expect(agreedTermsHash(terms([line(), second]))).not.toBe(base);
    expect(agreedTermsHash(terms([]))).not.toBe(base);
  });

  it('changes when the services, route or mode change', () => {
    expect(agreedTermsHash(terms(undefined, { services: ['MAIN_FREIGHT', 'CUSTOMS'] }))).not.toBe(
      base,
    );
    expect(
      agreedTermsHash(
        terms(undefined, { destinationLocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
      ),
    ).not.toBe(base);
    expect(agreedTermsHash(terms(undefined, { mode: 'ROAD', loadType: null }))).not.toBe(base);
  });

  it('keeps the services in any order', () => {
    const a = agreedTermsHash(terms(undefined, { services: ['CUSTOMS', 'MAIN_FREIGHT'] }));
    const b = agreedTermsHash(terms(undefined, { services: ['MAIN_FREIGHT', 'CUSTOMS'] }));
    expect(a).toBe(b);
  });

  it('covers an estimate: any change to any item, its measures included, changes it', () => {
    const items = [line(), line({ id: '22222222-2222-4222-8222-222222222222', lineNo: 2 })];
    const agreed = agreedTermsHash(terms(items, {}, estimate));
    expect(agreedTermsHash(terms(items, {}, estimate))).toBe(agreed);
    for (const change of [
      { volumeCbm: dec('2') },
      { weightKg: dec('20') },
      { heightCm: dec('80') },
      { quantity: 3 },
    ]) {
      expect(
        agreedTermsHash(terms([items[0]!, line({ ...items[1], ...change })], {}, estimate)),
      ).not.toBe(agreed);
    }
    // The amount agreed is part of it too.
    expect(
      agreedTermsHash(terms(items, {}, [{ ...estimate[0]!, lineTotal: dec('500') }])),
    ).not.toBe(agreed);
  });

  it('changes when the quotation is revised', () => {
    const input = terms();
    expect(
      agreedTermsHash({
        ...input,
        quotation: { ...input.quotation, updatedAt: new Date('2026-11-04T11:00:00.000Z') },
      }),
    ).not.toBe(base);
  });
});

describe('agreedTermsReconciled (Codex F193-1)', () => {
  it('holds when each line prices the quantity of the goods it covers', () => {
    expect(agreedTermsReconciled(terms())).toBe(true);
    expect(agreedTermsReconciled(terms([line(), line({ id: '2', lineNo: 2 })], {}, estimate))).toBe(
      true,
    );
  });

  it('fails when the booking carries other cargo than the quotation priced', () => {
    expect(agreedTermsReconciled(terms([line({ quantity: 2 })]))).toBe(false);
    // A line of the whole quotation (a staff quotation): 1 CBM priced, 2 CBM booked.
    const perCbm = [
      {
        lineNo: 1,
        chargeTypeCode: 'FREIGHT',
        unit: 'PER_CBM' as const,
        quantity: dec('1'),
        unitPrice: dec('100'),
        lineTotal: dec('100'),
        containerTypeCode: null,
        bookingItemId: null,
        coversAllItems: false,
      },
    ];
    expect(agreedTermsReconciled(terms([line({ volumeCbm: dec('1') })], {}, perCbm))).toBe(true);
    expect(agreedTermsReconciled(terms([line({ volumeCbm: dec('2') })], {}, perCbm))).toBe(false);
    // A line bound to a booking line that is gone, or no line at all.
    expect(
      agreedTermsReconciled(terms([line({ id: '33333333-3333-4333-8333-333333333333' })])),
    ).toBe(false);
    expect(agreedTermsReconciled(terms(undefined, {}, []))).toBe(false);
  });
});
