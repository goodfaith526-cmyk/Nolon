// @vitest-environment jsdom
import type { QuotationDefaultsDto, RateCardDto } from '@nolon/shared';
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
  useMasterData: () => ({
    currencies: [
      { code: 'AED', nameEn: 'Dirham', isActive: true },
      { code: 'EUR', nameEn: 'Euro', isActive: true },
      { code: 'USD', nameEn: 'US dollar', isActive: true },
    ],
    locations: [
      { id: 'l1', code: 'JEA', nameEn: 'Jebel Ali', isActive: true },
      { id: 'l2', code: 'PZU', nameEn: 'Port Sudan', isActive: true },
    ],
    chargeTypes: [{ code: 'FREIGHT', nameEn: 'Freight', isActive: true }],
  }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ({
    permissions: [],
    branches: [{ id: 'b1', nameEn: 'Dubai', today: '2026-10-19', defaultCurrency: 'AED' }],
  }),
  can: () => false,
}));
vi.mock('./Notice', async (actual) => ({
  ...(await actual<typeof import('./Notice')>()),
  Notice: () => null,
  useFailureText: () => () => 'failed',
}));

const { QuotationForm } = await import('./QuotationForm');

const defaults: Record<string, QuotationDefaultsDto> = {
  c1: {
    customerId: 'c1',
    currency: 'AED',
    currencySource: 'CUSTOMER',
    today: '2026-10-19',
    validUntil: '2026-11-18',
    validityDays: 30,
  },
  c2: {
    customerId: 'c2',
    currency: 'USD',
    currencySource: 'BRANCH',
    today: '2026-10-19',
    validUntil: '2026-11-18',
    validityDays: 30,
  },
};

const rate = {
  id: 'r1',
  chargeTypeCode: 'FREIGHT',
  cargoType: 'CONTAINER',
  containerTypeCode: '40HC',
  loadType: 'FCL',
  unit: 'PER_CONTAINER',
  price: '1000',
  currency: 'AED',
} as unknown as RateCardDto;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    (el as HTMLElement).click();
  });
}

function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the element as `this` below
  const setValue = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  act(() => {
    setValue?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

const buttonByText = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const selects = () => [...document.querySelectorAll('select')];
const currency = () =>
  selects().find((s) => [...s.options].some((o) => o.value === 'EUR')) as HTMLSelectElement;
const validUntil = () => document.querySelector('input[name="validUntil"]') as HTMLInputElement;
const rateSelect = () => document.querySelector('select[aria-label="rate"]') as HTMLSelectElement;

describe('QuotationForm new quotation defaults (functional review B3, B4, B6)', () => {
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    api.mockReset();
    api.mockImplementation((path: string) => {
      if (path.startsWith('/customers?')) {
        const id = path.includes('Second') ? 'c2' : 'c1';
        const customer = { id, name: id, number: id, branchId: 'b1', isActive: true };
        return Promise.resolve({ items: [customer], total: 1, page: 1, pageSize: 20 });
      }
      if (path.startsWith('/quotations/defaults?customerId=')) {
        return Promise.resolve(defaults[path.split('=')[1] ?? '']);
      }
      if (path.startsWith('/rates?')) {
        return Promise.resolve({ items: [rate], total: 1, page: 1, pageSize: 100 });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<QuotationForm />);
    });
    await flush();
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  async function pick(q: string, id: string) {
    change(document.querySelector('input[type="search"]') as HTMLInputElement, q);
    click(buttonByText('search'));
    await flush();
    click(
      [...document.querySelectorAll('ul.picker button')].find((b) => b.textContent?.startsWith(id)),
    );
    await flush();
  }

  it('starts with no route, currency or validity until the customer is picked', () => {
    expect(
      selects()
        .slice(0, 2)
        .map((s) => s.value),
    ).toEqual(['', '']);
    expect(currency().value).toBe('');
    expect(validUntil().value).toBe('');
    expect(api).not.toHaveBeenCalledWith(expect.stringContaining('/quotations/defaults'));
  });

  it("takes the customer's defaults and follows another customer while no line holds an amount", async () => {
    await pick('First', 'c1');
    expect(currency().value).toBe('AED');
    expect(validUntil().value).toBe('2026-11-18');
    expect(document.body.textContent).toContain('currencyFromCustomer');
    expect(document.body.textContent).toContain('validUntilFromDays');

    click(buttonByText('change'));
    await pick('Second', 'c2');
    expect(currency().value).toBe('USD');
    expect(document.body.textContent).toContain('currencyFromBranch');
  });

  it('keeps the currency of a rate already picked when another customer suggests another one', async () => {
    await pick('First', 'c1');
    change(selects()[0] as HTMLSelectElement, 'l1');
    change(selects()[1] as HTMLSelectElement, 'l2');
    await flush();
    change(rateSelect(), 'r1');
    expect(rateSelect().value).toBe('r1');

    click(buttonByText('change'));
    await pick('Second', 'c2');
    // The AED rate stays priced in AED: the USD suggestion is shown, not applied.
    expect(currency().value).toBe('AED');
    expect(rateSelect().value).toBe('r1');
    expect(document.body.textContent).toContain('currencySuggestionNotApplied');
  });

  it('keeps AED for a typed price when a USD customer is picked next (Codex F93-1)', async () => {
    await pick('First', 'c1');
    expect(currency().value).toBe('AED');
    change(document.querySelector('input[aria-label="unitPrice"]') as HTMLInputElement, '100');

    click(buttonByText('change'));
    await pick('Second', 'c2');
    expect(currency().value).toBe('AED');
    expect(
      (document.querySelector('input[aria-label="unitPrice"]') as HTMLInputElement).value,
    ).toBe('100');
    expect(document.body.textContent).toContain('currencySuggestionNotApplied');
    expect(document.body.textContent).not.toContain('currencyFromBranch');
  });

  it('keeps a currency and a date the person chose when the customer changes', async () => {
    await pick('First', 'c1');
    change(currency(), 'EUR');
    change(validUntil(), '2027-01-31');
    expect(document.body.textContent).not.toContain('currencyFromCustomer');

    click(buttonByText('change'));
    await pick('Second', 'c2');
    expect(currency().value).toBe('EUR');
    expect(validUntil().value).toBe('2027-01-31');
    expect(document.body.textContent).not.toContain('currencyFrom');
    expect(document.body.textContent).not.toContain('validUntilFromDays');
  });
});
