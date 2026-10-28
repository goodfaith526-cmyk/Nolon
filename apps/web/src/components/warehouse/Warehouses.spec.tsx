// @vitest-environment jsdom
import type { WarehouseDto, WarehouseStockDto } from '@nolon/shared';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
const ME = { permissions: ['*'], branches: [{ id: 'b1', code: 'DXB' }] };
const failed = () => 'failed';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('../StaffShell', () => ({ useMe: () => ME, can: () => true }));
vi.mock('../StatusBadge', () => ({ StatusBadge: ({ status }: { status: string }) => status }));
vi.mock('../commercial/Notice', async (actual) => ({
  ...(await actual<typeof import('../commercial/Notice')>()),
  Notice: () => null,
  useFailureText: () => failed,
}));

const { Warehouses } = await import('./Warehouses');

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const warehouse = (id: string, code: string) =>
  ({
    id,
    branchId: 'b1',
    code,
    nameEn: code,
    nameAr: code,
    address: null,
    locationId: null,
    isActive: true,
    storageLocations: [],
  }) as WarehouseDto;

const stock: WarehouseStockDto = {
  asOf: '2026-10-28',
  truncated: false,
  rows: [
    {
      shipmentId: 's1',
      shipmentNumber: 'NOL-SHP-1',
      branchCode: 'DXB',
      warehouseId: 'w1',
      warehouseCode: 'DXB-1',
      customerId: 'c1',
      customerName: 'Acme',
      packages: 6,
      weightKg: '600',
      heldSince: '2026-10-27',
      daysHeld: 1,
    },
  ],
  awaitingReceipt: [
    {
      shipmentId: 's2',
      shipmentNumber: 'NOL-SHP-2',
      branchCode: 'DXB',
      customerName: 'Beta',
      status: 'RECEIVED_ORIGIN_WAREHOUSE',
      statusAt: '2026-10-28T08:00:00.000Z',
    },
  ],
};

describe('Warehouses: the shipments in each warehouse now', () => {
  let el: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    el = document.createElement('div');
    document.body.append(el);
    api.mockReset();
    api.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/warehouses'
          ? [warehouse('w1', 'DXB-1'), warehouse('w2', 'DXB-2')]
          : path === '/warehouses/stock'
            ? stock
            : { locations: [] },
      ),
    );
  });
  afterEach(() => el.remove());

  it('lists each warehouse its own shipments, and the ones awaiting a receipt apart', async () => {
    const root = createRoot(el);
    act(() => root.render(<Warehouses />));
    await flush();
    const panels = [...el.querySelectorAll('.panel')];
    // First the shipments awaiting a receipt, linked to their warehouse tab.
    expect(panels[0]?.textContent).toContain('awaitingTitle {"count":1}');
    expect(panels[0]?.querySelector('a[href="/shipments/s2#warehouse"]')).not.toBeNull();
    const [w1, w2] = panels.slice(1);
    expect(w1?.textContent).toContain('stockTitle {"shipments":1,"packages":6}');
    expect(w1?.querySelector('a[href="/shipments/s1#warehouse"]')?.textContent).toBe('NOL-SHP-1');
    expect(w2?.textContent).toContain('stockTitle {"shipments":0,"packages":0}');
    expect(w2?.textContent).toContain('stockNone');
    expect(w2?.textContent).not.toContain('NOL-SHP-1');
    act(() => root.unmount());
  });
});
