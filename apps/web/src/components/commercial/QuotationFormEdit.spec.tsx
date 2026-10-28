// @vitest-environment jsdom
import type { QuotationDto, RateCardDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, useRouter: () => ({ push: () => {} }) }));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('@/lib/master-data', () => ({
  isPlace: (l: { kind?: string }) => l.kind !== 'COUNTRY',
  useMasterData: () => ({
    currencies: [{ code: 'USD', nameEn: 'US dollar', isActive: true }],
    locations: [
      { id: 'l1', code: 'JED', nameEn: 'Jeddah', isActive: true },
      { id: 'l2', code: 'PZU', nameEn: 'Port Sudan', isActive: true },
    ],
    chargeTypes: [{ code: 'FREIGHT', nameEn: 'Freight', isActive: true }],
    priceCategories: [
      { code: 'CARTON', nameEn: 'Carton', cargoType: 'GENERAL', isActive: true },
      { code: 'DRUM', nameEn: 'Drum', cargoType: 'GENERAL', isActive: true },
    ],
  }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ({
    permissions: [],
    branches: [{ id: 'b1', nameEn: 'Jeddah', today: '2026-10-28', defaultCurrency: 'USD' }],
  }),
  can: () => false,
}));
vi.mock('./Notice', async (actual) => ({
  ...(await actual<typeof import('./Notice')>()),
  Notice: () => null,
  useFailureText: () => () => 'failed',
}));

const { QuotationForm } = await import('./QuotationForm');

const cartonCard = {
  id: 'r-carton',
  chargeTypeCode: 'FREIGHT',
  cargoType: 'GENERAL',
  loadType: 'LCL',
  unit: 'PER_PIECE',
  price: '60',
  currency: 'USD',
  priceCategoryCode: 'CARTON',
} as unknown as RateCardDto;

const quotation = {
  id: 'q1',
  number: 'QT00001',
  branchId: 'b1',
  customerId: 'c1',
  originLocationId: 'l1',
  destinationLocationId: 'l2',
  mode: 'SEA',
  loadType: 'LCL',
  cargoType: 'GENERAL',
  cargoDescription: null,
  currency: 'USD',
  validUntil: '2026-11-27',
  terms: null,
  lines: [
    {
      rateCardId: 'r-carton',
      priceCategoryCode: 'CARTON',
      chargeTypeCode: 'FREIGHT',
      unit: 'PER_PIECE',
      unitPrice: '60',
      quantity: '10',
      discount: '0',
      description: null,
    },
  ],
} as unknown as QuotationDto;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function change(el: HTMLSelectElement, value: string) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the element as `this` below
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const select = (label: string) =>
  document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
const price = () => document.querySelector('input[aria-label="unitPrice"]') as HTMLInputElement;

describe('QuotationForm editing a line priced from a rate card (plan 5.2, Codex F120-1)', () => {
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    api.mockReset();
    api.mockImplementation((path: string) =>
      path.startsWith('/rates?')
        ? Promise.resolve({ items: [cartonCard], total: 1, page: 1, pageSize: 100 })
        : Promise.reject(new Error(`unexpected ${path}`)),
    );
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<QuotationForm quotation={quotation} />);
    });
    await flush();
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('drops the card’s price with the card when the category changes: nothing is sent as typed', () => {
    expect(select('rate').value).toBe('r-carton');
    change(select('priceCategory'), 'DRUM');
    expect(select('rate').value).toBe('');
    // The saved 60 was the card's price, not one the person typed.
    expect(price().value).toBe('');
  });

  it('drops the card’s price when the person takes the card off the line', () => {
    change(select('rate'), '');
    expect(price().value).toBe('');
  });
});
