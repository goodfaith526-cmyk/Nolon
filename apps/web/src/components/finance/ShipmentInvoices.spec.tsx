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

const invoice = (
  id: string,
  kind: CustomerInvoiceSummaryDto['kind'],
  live: boolean,
  status: CustomerInvoiceSummaryDto['status'] = live ? 'APPROVED' : 'CANCELLED',
) =>
  ({
    id,
    number: null,
    status,
    kind,
    live,
    total: '1',
    balance: '1',
    currency: 'USD',
  }) as CustomerInvoiceSummaryDto;

describe('ShipmentInvoices: main and additional-charges invoices (ب3)', () => {
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

  it('with no live main invoice, creates the main invoice', async () => {
    // A cancelled main invoice, and one credited in full (not live), do not count.
    const button = await render([
      invoice('i0', 'MAIN', false),
      invoice('i1', 'MAIN', false, 'APPROVED'),
    ]);
    expect(button?.textContent).toBe('create');
    expect(el.querySelector('input[type="checkbox"]')).toBeNull();
    act(() => button?.click());
    await flush();
    expect(api).toHaveBeenLastCalledWith('/customer-invoices', {
      method: 'POST',
      body: { shipmentId: 's1' },
    });
    expect(push).toHaveBeenCalledWith('/invoices/new/edit');
  });

  it('with a live main invoice, creates an additional-charges invoice', async () => {
    const button = await render([invoice('i1', 'MAIN', true), invoice('i2', 'ADDITIONAL', true)]);
    expect(button?.textContent).toBe('createAdditional');
    expect(button?.disabled).toBe(false);
    expect(el.textContent).toContain('additional');
    act(() => button?.click());
    await flush();
    expect(api).toHaveBeenLastCalledWith('/customer-invoices', {
      method: 'POST',
      body: { shipmentId: 's1', kind: 'ADDITIONAL' },
    });
  });

  it('reads every page before choosing', async () => {
    // The live main invoice behind 120 cancelled ones: past the first page.
    const items = [
      ...Array.from({ length: 120 }, (_, n) => invoice(`c${n}`, 'MAIN', false)),
      invoice('i1', 'MAIN', true),
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
    expect(el.querySelector('button.primary')?.textContent).toBe('createAdditional');
  });

  it('a refused create reads the list again, and the button follows it', async () => {
    let list = [invoice('i0', 'MAIN', false)];
    let refuse = true;
    api.mockImplementation((path: string) => {
      if (path.startsWith('/customer-invoices?')) {
        return Promise.resolve({ items: list, total: list.length });
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
    const button = () => el.querySelector<HTMLButtonElement>('button.primary');
    expect(button()?.textContent).toBe('create');
    // Someone created the main invoice meanwhile: refused, and the list read again.
    list = [invoice('i0', 'MAIN', false), invoice('i1', 'MAIN', true, 'DRAFT')];
    act(() => button()?.click());
    await flush();
    expect(button()?.textContent).toBe('createAdditional');
    act(() => button()?.click());
    await flush();
    expect(api).toHaveBeenLastCalledWith('/customer-invoices', {
      method: 'POST',
      body: { shipmentId: 's1', kind: 'ADDITIONAL' },
    });
  });
});
