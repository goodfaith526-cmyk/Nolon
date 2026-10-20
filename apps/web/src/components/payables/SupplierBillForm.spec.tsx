// @vitest-environment jsdom
import type { BillableTripDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
const DUBAI = {
  id: 'b1',
  code: 'DXB',
  nameEn: 'Dubai',
  today: '2026-10-19',
  defaultCurrency: 'AED',
};
const JEDDAH = {
  id: 'b2',
  code: 'JED',
  nameEn: 'Jeddah',
  today: '2026-10-20',
  defaultCurrency: 'SAR',
};
// Stable across renders, as the real hooks are: effects depend on them.
const ME = { permissions: ['*'], allBranches: false, branches: [DUBAI, JEDDAH] };
const failed = () => 'failed';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, useRouter: () => ({ push: () => {} }) }));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('@/lib/master-data', async (actual) => ({
  ...(await actual<typeof import('@/lib/master-data')>()),
  useMasterData: () => ({
    currencies: ['AED', 'EUR', 'SAR', 'USD'].map((code) => ({
      code,
      nameEn: code,
      isActive: true,
    })),
    chargeTypes: [{ code: 'FREIGHT', nameEn: 'Freight', isActive: true }],
  }),
  useLocalName: () => (x: { nameEn?: string }) => x.nameEn ?? '',
}));
vi.mock('../StaffShell', () => ({ useMe: () => ME, can: () => true }));
vi.mock('../commercial/Notice', async (actual) => ({
  ...(await actual<typeof import('../commercial/Notice')>()),
  Notice: () => null,
  useFailureText: () => failed,
}));

const { SupplierBillForm } = await import('./SupplierBillForm');

const trip = (tripId: string, currency: string, agreedCost: string): BillableTripDto => ({
  tripId,
  tripNumber: tripId,
  branchId: 'b1',
  carrierName: 'Carrier',
  completedOn: '2026-10-01',
  currency,
  agreedCost,
});
const TRIPS = [trip('T1', 'AED', '500'), trip('T2', 'EUR', '300'), trip('T3', 'EUR', '200')];
const SHIPMENT = { id: 'sh1', number: 'NOL-SHP-000001', customerName: 'Tariq' };

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

function click(el: Element | null | undefined) {
  if (!el) throw new Error('Nothing to click');
  act(() => {
    (el as HTMLElement).click();
  });
}

/** The select or input of the label whose text starts with `text` (translation keys here). */
function control<T extends HTMLSelectElement | HTMLInputElement>(text: string): T {
  const label = [...document.querySelectorAll('label')].find(
    (l) => (l.firstChild?.textContent ?? '').trim() === text,
  );
  const found = label?.querySelector('select, input');
  if (!found) throw new Error(`No field ${text}`);
  return found as T;
}

const buttons = (text: string) =>
  [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes(text));

describe('SupplierBillForm defaults (functional review C1, C2, C4, C9, C10)', () => {
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    api.mockReset();
    api.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return Promise.resolve({ id: 'bill1' });
      if (path.startsWith('/suppliers?')) {
        return Promise.resolve({ items: [{ id: 's1', name: 'Haulage', isActive: true }] });
      }
      if (path === '/suppliers/s1') return Promise.resolve({ id: 's1', paymentTermsDays: 30 });
      if (path.startsWith('/suppliers/s1/billable-trips')) return Promise.resolve(TRIPS);
      if (path.startsWith('/shipments/pick')) {
        return Promise.resolve({ exact: SHIPMENT, items: [], total: 0, page: 1, pageSize: 10 });
      }
      return Promise.resolve([]);
    });
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<SupplierBillForm />));
    await flush();
    change(control('supplier'), 's1');
    await flush();
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  const amount = () => control<HTMLInputElement>('amount');
  const tripSelect = () => control<HTMLSelectElement>('trip');

  it("starts in the branch's currency and today, with the due date left to the terms", () => {
    expect(control<HTMLSelectElement>('currency').value).toBe('AED');
    expect(control<HTMLInputElement>('billDate').value).toBe('2026-10-19');
    expect(control<HTMLInputElement>('dueDateOptional').value).toBe('');
    expect(document.body.textContent).toContain('dueDateFromTerms');
    change(control('branch'), 'b2');
    expect(control<HTMLSelectElement>('currency').value).toBe('SAR');
    expect(control<HTMLInputElement>('billDate').value).toBe('2026-10-20');
  });

  it("offers the trips' other currencies without picking one", () => {
    expect(buttons('useTripCurrency')).toHaveLength(1);
    expect(control<HTMLSelectElement>('currency').value).toBe('AED');
    click(buttons('useTripCurrency')[0]);
    expect(control<HTMLSelectElement>('currency').value).toBe('EUR');
  });

  it("copies a picked trip's cost, and drops it when the trip or the currency changes", () => {
    change(control('lineKind'), 'TRIP');
    change(tripSelect(), 'T1');
    expect(amount().value).toBe('500');
    change(tripSelect(), '');
    expect(amount().value).toBe('');

    change(tripSelect(), 'T1');
    change(control('currency'), 'EUR');
    expect(tripSelect().value).toBe('');
    expect(amount().value).toBe('');
    change(tripSelect(), 'T2');
    expect(amount().value).toBe('300');
    change(tripSelect(), 'T3');
    expect(amount().value).toBe('200');
  });

  it('keeps an amount the person typed', () => {
    change(control('lineKind'), 'TRIP');
    change(tripSelect(), 'T1');
    change(amount(), '480');
    change(tripSelect(), '');
    expect(amount().value).toBe('480');
    change(control('currency'), 'EUR');
    expect(amount().value).toBe('480');
  });

  it('keeps a typed amount in its currency when the branch changes (Codex F94-2)', () => {
    change(amount(), '100');
    change(control('branch'), 'b2');
    expect(control<HTMLSelectElement>('currency').value).toBe('AED');
    expect(amount().value).toBe('100');
  });

  it('sends the picked shipment and no due date, for the API to generate', async () => {
    change(control('lineKind'), 'SHIPMENT_COST');
    const search = document.querySelector<HTMLInputElement>('input[type="search"]');
    change(search as HTMLInputElement, 'nol-shp-000001');
    click(buttons('search')[0]);
    await flush();
    expect(api).toHaveBeenCalledWith(
      '/shipments/pick?branchId=b1&q=nol-shp-000001&page=1&pageSize=10',
    );
    click(buttons('exactMatch')[0]);
    change(control('chargeType'), 'FREIGHT');
    change(amount(), '75');
    await act(async () => {
      document
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const post = api.mock.calls.find(
      ([, init]) => (init as { method?: string })?.method === 'POST',
    );
    const body = (post?.[1] as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({
      currency: 'AED',
      billDate: '2026-10-19',
      dueDate: null,
      lines: [
        { kind: 'SHIPMENT_COST', shipmentId: 'sh1', chargeTypeCode: 'FREIGHT', amount: '75' },
      ],
    });
  });
});
