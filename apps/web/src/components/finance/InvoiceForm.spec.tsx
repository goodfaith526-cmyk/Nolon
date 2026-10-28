// @vitest-environment jsdom
import type { CustomerInvoiceDto } from '@nolon/shared';
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
vi.mock('@/lib/master-data', async (actual) => ({
  ...(await actual<typeof import('@/lib/master-data')>()),
  useMasterData: () => ({
    currencies: [
      { code: 'USD', nameEn: 'US dollar', isActive: true },
      { code: 'EUR', nameEn: 'Euro', isActive: true },
    ],
    chargeTypes: [
      { code: 'FREIGHT', nameEn: 'Freight', isActive: true },
      { code: 'DOCS', nameEn: 'Documents', isActive: true },
    ],
  }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));
vi.mock('../commercial/Notice', async (actual) => ({
  ...(await actual<typeof import('../commercial/Notice')>()),
  Notice: () => null,
  useFailureText: () => () => 'failed',
}));

const { InvoiceEdit } = await import('./InvoiceForm');

const invoice = {
  id: 'inv1',
  number: null,
  customerName: 'Tariq',
  shipmentNumber: 'NOL-SHP-000001',
  currency: 'USD',
  enteredFxRate: null,
  invoiceDate: '2026-10-19',
  dueDate: '2026-10-19',
  notes: null,
  actions: { canEdit: true },
  lines: [{ chargeTypeCode: 'FREIGHT', description: null, quantity: '1', unitPrice: '100' }],
} as unknown as CustomerInvoiceDto;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
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

const selects = () => document.querySelectorAll('select');
const currencySelect = () => selects()[0] as HTMLSelectElement;
const chargeSelect = () => selects()[1] as HTMLSelectElement;
// The line's inputs: description, quantity, unit price.
const price = () => document.querySelectorAll('.line input')[2] as HTMLInputElement;

describe('InvoiceForm currency change (Codex F92-6)', () => {
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    api.mockReset();
    api.mockResolvedValue(invoice);
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<InvoiceEdit id="inv1" />);
    });
    await flush();
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('clears the prices in another currency and restores them back in its own', () => {
    expect(price().value).toBe('100');
    change(currencySelect(), 'EUR');
    expect(price().value).toBe('');
    change(currencySelect(), 'USD');
    expect(price().value).toBe('100');
  });

  it('does not put a saved price on a line whose charge changed', () => {
    change(currencySelect(), 'EUR');
    change(chargeSelect(), 'DOCS');
    change(currencySelect(), 'USD');
    expect(chargeSelect().value).toBe('DOCS');
    expect(price().value).toBe('');
  });

  it('does not put a saved price over a price the user typed', () => {
    change(currencySelect(), 'EUR');
    change(price(), '92');
    change(currencySelect(), 'USD');
    expect(price().value).toBe('');
  });
});

describe('InvoiceForm pricing notice (Codex F139-1)', () => {
  let root: ReturnType<typeof createRoot>;

  async function open(inv: CustomerInvoiceDto) {
    api.mockReset();
    api.mockResolvedValue(inv);
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root.render(<InvoiceEdit id="inv1" />);
    });
    await flush();
  }
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('tells the editor why the prices are not the quotation’s', async () => {
    await open({
      ...invoice,
      pricingNotice: { code: 'QUOTATION_CATEGORY_CHANGED', quotationNumber: 'NOL-QUO-000001' },
    });
    expect(document.querySelector('.warning')?.textContent).toBe(
      'pricingNotice_QUOTATION_CATEGORY_CHANGED',
    );
  });

  it('shows nothing when the quotation still prices the shipment', async () => {
    await open({ ...invoice, pricingNotice: null });
    expect(document.querySelector('.warning')).toBeNull();
  });
});
