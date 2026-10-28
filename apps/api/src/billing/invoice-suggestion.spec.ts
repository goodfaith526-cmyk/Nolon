import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/auth-user.js';
import { dec } from '../common/money.js';
import { InvoicesService } from './invoices.service.js';
import {
  type CargoLine,
  invoiceCurrency,
  quotationDrift,
  quotedLine,
  ratedLine,
  ratedPrice,
  shipmentPriceCategory,
  suggestionFingerprint,
  systemPriceGives,
  unitQuantity,
} from './invoice-suggestion.js';

const item = (values: Partial<CargoLine>): CargoLine => ({
  cargoType: 'GENERAL',
  containerTypeCode: null,
  quantity: 1,
  weightKg: null,
  volumeCbm: null,
  ...values,
});

describe('invoice suggestion: currency', () => {
  it('takes the one asked for, else the quotation, the customer, the branch', () => {
    const all = { requested: 'EUR', quotation: 'SDG', customer: 'USD', branch: 'AED' };
    expect(invoiceCurrency(all)).toEqual({ code: 'EUR', source: 'REQUESTED' });
    expect(invoiceCurrency({ ...all, requested: null })).toEqual({
      code: 'SDG',
      source: 'QUOTATION',
    });
    expect(invoiceCurrency({ ...all, requested: null, quotation: null })).toEqual({
      code: 'USD',
      source: 'CUSTOMER',
    });
    expect(
      invoiceCurrency({ requested: null, quotation: null, customer: null, branch: 'AED' }),
    ).toEqual({ code: 'AED', source: 'BRANCH' });
  });
});

describe('invoice suggestion: quantity per unit', () => {
  const items = [
    item({ cargoType: 'PALLET', quantity: 4, weightKg: dec('400.5'), volumeCbm: dec('3.2') }),
    item({ cargoType: 'PALLET', quantity: 2, weightKg: dec('100'), volumeCbm: dec('1.3') }),
    item({ cargoType: 'BARREL', quantity: 5, weightKg: dec('50'), volumeCbm: dec('0.5') }),
  ];
  const quantity = (unit: Parameters<typeof unitQuantity>[0], lines = items) =>
    unitQuantity(unit, lines, null, 'PALLET')?.toString() ?? null;

  it('is exact where the unit makes it so', () => {
    expect(quantity('PER_SHIPMENT')).toBe('1');
    expect(quantity('PER_PALLET')).toBe('6');
    expect(quantity('PER_BARREL')).toBe('5');
    expect(quantity('PER_PIECE')).toBe('6');
    expect(quantity('PER_KG')).toBe('550.5');
    expect(quantity('PER_CBM')).toBe('5');
  });

  it('is null when one item lacks its weight or volume, never a sum of the others', () => {
    const missing = [...items, item({ cargoType: 'PALLET', quantity: 1, volumeCbm: dec('1') })];
    expect(quantity('PER_KG', missing)).toBeNull();
    expect(quantity('PER_CBM', missing)).toBe('6');
    expect(quantity('PER_CBM', [...missing, item({ weightKg: dec('1') })])).toBeNull();
    expect(quantity('PER_KG', [])).toBeNull();
  });

  it('is null when the shipment has none of what the unit counts', () => {
    const general = [item({ quantity: 3, weightKg: dec('10') })];
    expect(quantity('PER_PALLET', general)).toBeNull();
    expect(quantity('PER_BARREL', general)).toBeNull();
    expect(quantity('PER_CONTAINER', general)).toBeNull();
  });

  it('counts the containers of the rate type, and of any type only when there is one', () => {
    const containers = [
      item({ cargoType: 'CONTAINER', containerTypeCode: '20GP', quantity: 2 }),
      item({ cargoType: 'CONTAINER', containerTypeCode: '40HC', quantity: 1 }),
    ];
    const of = (type: string | null, lines = containers) =>
      unitQuantity('PER_CONTAINER', lines, type, 'CONTAINER')?.toString() ?? null;
    expect(of('20GP')).toBe('2');
    expect(of('40HC')).toBe('1');
    expect(of('45HC')).toBeNull();
    expect(of(null)).toBeNull();
    expect(of(null, containers.slice(0, 1))).toBe('2');
    // A container line with no type makes any count ambiguous.
    expect(of('20GP', [...containers, item({ cargoType: 'CONTAINER', quantity: 1 })])).toBeNull();
  });
});

describe('invoice suggestion: prices', () => {
  it('keeps a quoted line, and invoices a minimum or a discount as one unit', () => {
    expect(
      quotedLine({ quantity: dec(3), unitPrice: dec('250.125'), lineTotal: dec('750.38') }, 2),
    ).toEqual({ quantity: dec(3), unitPrice: dec('250.125') });
    expect(quotedLine({ quantity: dec(1), unitPrice: dec(100), lineTotal: dec(90) }, 2)).toEqual({
      quantity: dec(1),
      unitPrice: dec(90),
    });
    expect(quotedLine({ quantity: dec(2), unitPrice: dec(10), lineTotal: dec(50) }, 2)).toEqual({
      quantity: dec(1),
      unitPrice: dec(50),
    });
  });

  it("invoices a rate card's minimum charge as one unit", () => {
    const rate = { price: dec(1), minimumCharge: dec(50) };
    expect(ratedLine(rate, dec(10), 2)).toEqual({ quantity: dec(1), unitPrice: dec(50) });
    expect(ratedLine(rate, dec(80), 2)).toEqual({ quantity: dec(80), unitPrice: dec(1) });
    expect(ratedLine(rate, dec(50), 2)).toEqual({ quantity: dec(50), unitPrice: dec(1) });
    expect(ratedLine(rate, null, 2)).toEqual({ quantity: null, unitPrice: dec(1) });
  });
});

describe('invoice suggestion: the system price of a rate card line (Codex N89-1, N89-3)', () => {
  const rate = { price: dec(100), minimumCharge: dec(60) };
  it("prices a line from its own quantity only, never from the shipment's measure", () => {
    expect(ratedPrice(rate, dec(1), 2)).toEqual({ unitPrice: dec(100) });
    expect(ratedPrice(rate, dec(3), 2)).toEqual({ unitPrice: dec(100) });
    expect(ratedPrice(rate, dec('0.25'), 2)).toEqual({ oneUnit: dec(60) });
    expect(ratedPrice({ price: dec(1), minimumCharge: dec(50) }, dec(1), 2)).toEqual({
      unitPrice: dec(50),
    });
  });
  it('fills a suggested line only when the system price makes the same of it', () => {
    // 0.25 kg at 100/kg, minimum 60: suggested 1 × 60, but 1 unit with no price is 1 × 100.
    expect(systemPriceGives(rate, ratedLine(rate, dec('0.25'), 2), 2)).toBe(false);
    expect(systemPriceGives(rate, ratedLine(rate, dec(3), 2), 2)).toBe(true);
    // 10 kg at 1/kg, minimum 50: 1 × 50 either way.
    const low = { price: dec(1), minimumCharge: dec(50) };
    expect(systemPriceGives(low, ratedLine(low, dec(10), 2), 2)).toBe(true);
    expect(systemPriceGives(rate, ratedLine(rate, null, 2), 2)).toBe(true);
  });
});

describe('invoice suggestion: fingerprint', () => {
  const base = {
    shipmentId: 'A0000000-0000-4000-8000-000000000001',
    branchId: 'b0000000-0000-4000-8000-000000000002',
    currency: 'USD',
    currencySource: 'BRANCH' as const,
    pricingDate: '2026-10-18',
    dueDate: '2026-11-17',
    source: {
      rateCards: [
        { id: 'r2', updatedAt: new Date('2026-10-01T00:00:00Z') },
        { id: 'r1', updatedAt: new Date('2026-10-02T00:00:00Z') },
      ],
    },
    lines: [
      {
        chargeTypeCode: 'FREIGHT',
        description: null,
        unit: 'PER_SHIPMENT' as const,
        quantity: dec(1),
        unitPrice: dec(300),
        priceSource: 'RATE_CARD',
        rateCardId: 'r1',
        service: null,
        use: 'FILL',
        fillPrice: false,
      },
    ],
    unresolved: [] as { path: string; code: string }[],
  };
  const fingerprint = suggestionFingerprint(base);

  it('is the same for the same inputs, whatever the order of the rate cards or id case', () => {
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      suggestionFingerprint({
        ...base,
        shipmentId: base.shipmentId.toLowerCase(),
        source: { rateCards: [...base.source.rateCards].reverse() },
      }),
    ).toBe(fingerprint);
  });

  it('changes with each input it covers', () => {
    const changed = [
      { ...base, shipmentId: 'a0000000-0000-4000-8000-000000000009' },
      { ...base, branchId: 'b0000000-0000-4000-8000-000000000009' },
      { ...base, currency: 'EUR' },
      { ...base, pricingDate: '2026-10-19' },
      {
        ...base,
        source: {
          rateCards: [
            { id: 'r2', updatedAt: new Date('2026-10-03T00:00:00Z') },
            base.source.rateCards[1]!,
          ],
        },
      },
      { ...base, source: { quotation: { id: 'q1', updatedAt: new Date(0) } } },
      { ...base, lines: [{ ...base.lines[0]!, unit: 'PER_KG' as const }] },
      { ...base, lines: [{ ...base.lines[0]!, service: 'MAIN_FREIGHT' as const }] },
      // Everything it derived (Codex N89-2): equal fingerprints, same suggestion.
      { ...base, dueDate: '2026-12-02' },
      { ...base, currencySource: 'CUSTOMER' as const },
      { ...base, lines: [{ ...base.lines[0]!, quantity: dec(2) }] },
      { ...base, lines: [{ ...base.lines[0]!, quantity: null }] },
      { ...base, lines: [{ ...base.lines[0]!, unitPrice: dec(60) }] },
      { ...base, lines: [{ ...base.lines[0]!, description: 'x' }] },
      { ...base, lines: [{ ...base.lines[0]!, use: 'OFFER' }] },
      { ...base, lines: [{ ...base.lines[0]!, rateCardId: 'r2' }] },
      { ...base, lines: [{ ...base.lines[0]!, fillPrice: true }] },
      { ...base, unresolved: [{ path: 'lines.0.quantity', code: 'QUANTITY_UNKNOWN' }] },
    ];
    for (const input of changed) expect(suggestionFingerprint(input)).not.toBe(fingerprint);
  });
});

describe('invoice suggestion: derivation', () => {
  const user = { id: 'u1' } as AuthUser;
  const rate = (values: { id: string; chargeTypeCode: string; unit: string; price: string }) => ({
    ...values,
    containerTypeCode: null,
    minimumCharge: dec(0),
    price: dec(values.price),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  });

  /** InvoicesService over fakes: a direct shipment (no quotation) with MAIN_FREIGHT only. */
  function service(
    options: { quotation?: object; paymentTermsDays?: number; items?: CargoLine[] } = {},
  ) {
    const fakes = {
      shipments: {
        billingSource: () =>
          Promise.resolve({
            id: 's1',
            branchId: 'b1',
            customerId: 'c1',
            status: 'DELIVERED',
            quotationId: options.quotation ? 'q1' : null,
            originLocationId: 'o',
            destinationLocationId: 'd',
            mode: 'SEA',
            loadType: 'LCL',
            cargoType: 'GENERAL',
            services: ['MAIN_FREIGHT'],
            items: options.items ?? [
              item({ quantity: 2, weightKg: dec(100) }),
              item({ quantity: 1 }),
            ],
            priceCategoryCodes: [null],
          }),
      },
      customers: {
        requireCustomer: () =>
          Promise.resolve({
            preferredCurrency: null,
            paymentTermsDays: options.paymentTermsDays ?? 30,
          }),
      },
      prisma: {
        branch: {
          findUniqueOrThrow: () =>
            Promise.resolve({ defaultCurrency: 'AED', timezone: 'Asia/Dubai' }),
        },
      },
      quotations: { invoiceSource: () => Promise.resolve(options.quotation ?? null) },
      currencies: { requireActive: (code: string) => Promise.resolve({ code, decimalPlaces: 2 }) },
      rates: {
        systemRates: () =>
          Promise.resolve([
            rate({
              id: 'r-freight',
              chargeTypeCode: 'FREIGHT',
              unit: 'PER_SHIPMENT',
              price: '300',
            }),
            rate({ id: 'r-pickup', chargeTypeCode: 'PICKUP', unit: 'PER_SHIPMENT', price: '40' }),
            rate({ id: 'r-docs', chargeTypeCode: 'DOCS', unit: 'PER_SHIPMENT', price: '15' }),
            rate({ id: 'r-thc', chargeTypeCode: 'THC', unit: 'PER_KG', price: '0.5' }),
            rate({ id: 'r-st1', chargeTypeCode: 'STORAGE', unit: 'PER_KG', price: '1' }),
            rate({ id: 'r-st2', chargeTypeCode: 'STORAGE', unit: 'PER_CBM', price: '9' }),
          ]),
      },
      masterData: {
        activeChargeTypes: () =>
          Promise.resolve(
            new Map(
              Object.entries({
                FREIGHT: 'MAIN_FREIGHT',
                PICKUP: 'PICKUP',
                DOCS: null,
                THC: 'MAIN_FREIGHT',
                STORAGE: 'WAREHOUSE',
              }).map(([code, service]) => [code, { code, service }]),
            ),
          ),
      },
    };
    // The derivation uses none of the posting dependencies (journal, fx rates).
    const args = [
      fakes.prisma,
      null,
      null,
      fakes.shipments,
      fakes.quotations,
      fakes.customers,
      fakes.currencies,
      fakes.masterData,
      fakes.rates,
    ] as unknown as ConstructorParameters<typeof InvoicesService>;
    return new InvoicesService(...args);
  }

  it('fills a rate card line only for a service the shipment has, with an exact quantity', async () => {
    const derived = await service().deriveForShipment(user, 's1', { invoiceDate: '2026-10-18' });
    expect(derived.currency.code).toBe('AED');
    expect(derived.currencySource).toBe('BRANCH');
    expect(derived.dueDate).toBe('2026-11-17');
    expect(
      derived.lines.map((l) => [l.chargeTypeCode, l.quantity?.toString() ?? null, l.use]),
    ).toEqual([
      ['DOCS', '1', 'OFFER'],
      ['FREIGHT', '1', 'FILL'],
      ['PICKUP', '1', 'OFFER'],
      // One cargo line has no weight: no quantity, so not filled.
      ['THC', null, 'OFFER'],
    ]);
    expect(derived.unresolved).toEqual([
      expect.objectContaining({ path: 'lines.0', code: 'SERVICE_NOT_MAPPED' }),
      expect.objectContaining({ path: 'lines.2', code: 'SERVICE_NOT_ON_SHIPMENT' }),
      expect.objectContaining({ path: 'lines', code: 'RATE_SEVERAL' }),
      expect.objectContaining({ path: 'lines.3.quantity', code: 'QUANTITY_UNKNOWN' }),
    ]);
  });

  it("dates the invoice as asked and dues it after the customer's payment terms", async () => {
    const derived = await service({ paymentTermsDays: 45 }).deriveForShipment(user, 's1', {
      invoiceDate: '2026-12-20',
      currency: 'EUR',
    });
    expect([derived.invoiceDate, derived.dueDate]).toEqual(['2026-12-20', '2027-02-03']);
    expect([derived.currency.code, derived.currencySource]).toEqual(['EUR', 'REQUESTED']);
  });

  it("takes the quotation's lines, and prices none in another currency", async () => {
    const quotation = {
      id: 'q1',
      number: 'NOL-QT-2026-000001',
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      currency: 'SDG',
      originLocationId: 'o',
      destinationLocationId: 'd',
      mode: 'SEA',
      lines: [
        {
          priceCategoryCode: null,
          chargeTypeCode: 'FREIGHT',
          description: 'Sea freight',
          quantity: dec(2),
          unitPrice: dec(1000),
          lineTotal: dec(2000),
          unit: 'PER_SHIPMENT',
        },
      ],
    };
    const own = await service({ quotation }).deriveForShipment(user, 's1', {});
    expect(own.currencySource).toBe('QUOTATION');
    expect(own.lines).toMatchObject([
      { quantity: dec(2), unitPrice: dec(1000), priceSource: 'QUOTATION', use: 'FILL' },
    ]);
    expect(own.unresolved).toEqual([]);
    const other = await service({ quotation }).deriveForShipment(user, 's1', { currency: 'USD' });
    expect(other.lines).toMatchObject([{ unitPrice: null, use: 'OFFER' }]);
    expect(other.unresolved).toMatchObject([
      { path: 'lines.0.unitPrice', code: 'QUOTED_PRICE_OTHER_CURRENCY' },
    ]);
    expect(other.fingerprint).not.toBe(own.fingerprint);

    // The shipment went by road after all: the quotation's prices are not used (plan 5.2).
    const moved = await service({ quotation: { ...quotation, mode: 'ROAD' } }).deriveForShipment(
      user,
      's1',
      {},
    );
    expect(moved.currencySource).toBe('BRANCH');
    expect(moved.unresolved[0]).toMatchObject({ path: 'lines', code: 'QUOTATION_ROUTE_CHANGED' });
    expect(moved.lines.some((l) => l.priceSource === 'QUOTATION')).toBe(false);
    expect(moved.lines.find((l) => l.chargeTypeCode === 'FREIGHT')?.rateCardId).toBe('r-freight');
  });

  it('changes its fingerprint with the shipment measures alone, and the payment terms alone (Codex N89-2)', async () => {
    const at = { invoiceDate: '2026-10-18' };
    const kg = (weightKg: string) => [item({ quantity: 1, weightKg: dec(weightKg) })];
    const one = await service({ items: kg('1') }).deriveForShipment(user, 's1', at);
    const two = await service({ items: kg('2') }).deriveForShipment(user, 's1', at);
    expect(two.lines.find((l) => l.chargeTypeCode === 'THC')?.quantity).toEqual(dec(2));
    expect(two.fingerprint).not.toBe(one.fingerprint);
    const again = await service({ items: kg('1') }).deriveForShipment(user, 's1', at);
    expect(again.fingerprint).toBe(one.fingerprint);
    const later = await service({ items: kg('1'), paymentTermsDays: 45 }).deriveForShipment(
      user,
      's1',
      at,
    );
    expect(later.dueDate).not.toBe(one.dueDate);
    expect(later.fingerprint).not.toBe(one.fingerprint);
  });
});

describe('a quotation that no longer prices the shipment (plan 5.2)', () => {
  const route = { originLocationId: 'a', destinationLocationId: 'b', mode: 'ROAD' };
  const quotation = (...codes: (string | null)[]) => ({
    ...route,
    lines: codes.map((priceCategoryCode) => ({ priceCategoryCode })),
  });
  const shipment = (...priceCategoryCodes: (string | null)[]) => ({
    ...route,
    priceCategoryCodes,
  });

  it('is the same while route, mode and the set of categories are', () => {
    expect(quotationDrift(quotation(null, null), shipment(null))).toBeNull();
    // More lines in a category both have is no change; nor is a line without one.
    expect(quotationDrift(quotation('CARTON', null), shipment('CARTON', 'CARTON'))).toBeNull();
    expect(quotationDrift(quotation('CARTON', 'BARREL'), shipment('BARREL', 'CARTON'))).toBeNull();
  });

  it('drifts on another route or mode, or another set of categories', () => {
    expect(quotationDrift(quotation(), { ...shipment(), destinationLocationId: 'c' })).toBe(
      'ROUTE',
    );
    expect(quotationDrift(quotation(), { ...shipment(), mode: 'SEA' })).toBe('ROUTE');
    expect(quotationDrift(quotation(null), shipment('CARTON'))).toBe('CATEGORY');
    expect(quotationDrift(quotation('CARTON'), shipment(null))).toBe('CATEGORY');
    expect(quotationDrift(quotation('CARTON'), shipment('CARTON', 'BARREL'))).toBe('CATEGORY');
  });

  it("asks the rate cards for the shipment's one category only", () => {
    expect(shipmentPriceCategory(['CARTON', 'CARTON'])).toBe('CARTON');
    expect(shipmentPriceCategory(['CARTON', 'BARREL'])).toBeNull();
    expect(shipmentPriceCategory(['CARTON', null])).toBeNull();
    expect(shipmentPriceCategory([null])).toBeNull();
    expect(shipmentPriceCategory([])).toBeNull();
  });
});
