// @vitest-environment jsdom
import type { CustomerInvoiceSummaryDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
const push = vi.fn();
const ME = { permissions: ['*'] };
const failed = () => 'failed';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({ Link: () => null, useRouter: () => ({ push }) }));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('../StaffShell', () => ({ useMe: () => ME, can: () => true }));
vi.mock('../commercial/Notice', async (actual) => ({
  ...(await actual<typeof import('../commercial/Notice')>()),
  Notice: () => null,
  useFailureText: () => failed,
}));

const { ShipmentInvoices } = await import('./ShipmentInvoices');

/** Lets the effects and the API promises settle. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const invoice = (id: string, status: CustomerInvoiceSummaryDto['status']) =>
  ({
    id,
    number: null,
    status,
    total: '1',
    balance: '1',
    currency: 'USD',
  }) as CustomerInvoiceSummaryDto;

describe('ShipmentInvoices: another invoice for an invoiced shipment (Q3)', () => {
  let el: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    el = document.createElement('div');
    document.body.append(el);
    api.mockReset();
    push.mockReset();
  });
  afterEach(() => el.remove());

  async function render(items: CustomerInvoiceSummaryDto[]) {
    api.mockImplementation((path: string) =>
      path.startsWith('/customer-invoices?')
        ? Promise.resolve({ items, total: items.length })
        : Promise.resolve({ id: 'new' }),
    );
    const root = createRoot(el);
    act(() => root.render(<ShipmentInvoices shipmentId="s1" />));
    await flush();
    return el.querySelector<HTMLButtonElement>('button.primary');
  }

  it('creates the first invoice without a tick, naming no invoice', async () => {
    const button = await render([invoice('i0', 'CANCELLED')]);
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    await flush();
    expect(api).toHaveBeenLastCalledWith('/customer-invoices', {
      method: 'POST',
      body: { shipmentId: 's1', acknowledgedInvoiceIds: [] },
    });
  });

  it('asks for the tick, then names the invoices that are not cancelled', async () => {
    const button = await render([invoice('i1', 'APPROVED'), invoice('i0', 'CANCELLED')]);
    expect(el.textContent).toContain('otherInvoicesWarning');
    expect(button?.disabled).toBe(true);
    act(() => el.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    await flush();
    expect(api).toHaveBeenLastCalledWith('/customer-invoices', {
      method: 'POST',
      body: { shipmentId: 's1', acknowledgedInvoiceIds: ['i1'] },
    });
    expect(push).toHaveBeenCalledWith('/invoices/new/edit');
  });
  it('reads every page, so the ids sent are all the invoices that are not cancelled', async () => {
    // 51 open invoices behind 60 cancelled ones: more than a page of either.
    const items = [
      ...Array.from({ length: 60 }, (_, n) => invoice(`c${n}`, 'CANCELLED')),
      ...Array.from({ length: 51 }, (_, n) => invoice(`i${n}`, 'APPROVED')),
    ];
    api.mockImplementation((path: string) => {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
      return path.startsWith('/customer-invoices?')
        ? Promise.resolve({ items: items.slice((page - 1) * 100, page * 100), total: items.length })
        : Promise.resolve({ id: 'new' });
    });
    const root = createRoot(el);
    act(() => root.render(<ShipmentInvoices shipmentId="s1" />));
    await flush();
    act(() => el.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    act(() => el.querySelector<HTMLButtonElement>('button.primary')?.click());
    await flush();
    const body = (api.mock.lastCall?.[1] as { body: { acknowledgedInvoiceIds: string[] } }).body;
    expect(body.acknowledgedInvoiceIds).toHaveLength(51);
    expect(body.acknowledgedInvoiceIds).toEqual(items.slice(60).map((i) => i.id));
  });

  it('a refused create reads the list again; a tick given before it arrives does not carry over', async () => {
    let list = [invoice('i1', 'APPROVED')];
    let release: () => void = () => {};
    let refuse = true;
    api.mockImplementation((path: string) => {
      if (path.startsWith('/customer-invoices?')) {
        const items = list;
        // The read after the refusal answers only when released.
        return refuse
          ? Promise.resolve({ items, total: items.length })
          : new Promise((resolve) => {
              release = () => resolve({ items, total: items.length });
            });
      }
      if (refuse) {
        refuse = false;
        return Promise.reject(new Error('409'));
      }
      return Promise.resolve({ id: 'new' });
    });
    const root = createRoot(el);
    act(() => root.render(<ShipmentInvoices shipmentId="s1" />));
    await flush();
    const box = () => el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const button = () => el.querySelector<HTMLButtonElement>('button.primary');
    act(() => box()?.click());
    // Another invoice was added meanwhile: the create is refused and the list read again.
    list = [invoice('i1', 'APPROVED'), invoice('i2', 'DRAFT')];
    act(() => button()?.click());
    await flush();
    // While the new list is on its way, nothing can be ticked or created.
    expect(box()?.disabled).toBe(true);
    expect(button()?.disabled).toBe(true);
    act(() => box()?.click());
    act(() => release());
    await flush();
    // The new list asks for its own tick before anything is sent.
    expect(box()?.checked).toBe(false);
    expect(button()?.disabled).toBe(true);
    const creates = () => api.mock.calls.filter(([path]) => path === '/customer-invoices').length;
    expect(creates()).toBe(1);
    act(() => box()?.click());
    act(() => button()?.click());
    await flush();
    expect(api).toHaveBeenLastCalledWith('/customer-invoices', {
      method: 'POST',
      body: { shipmentId: 's1', acknowledgedInvoiceIds: ['i1', 'i2'] },
    });
  });
});
