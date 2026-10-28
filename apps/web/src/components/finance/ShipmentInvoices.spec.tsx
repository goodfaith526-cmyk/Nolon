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
});
