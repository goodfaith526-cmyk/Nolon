// @vitest-environment jsdom
import type { WindowDeskBookingDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowDesk } from './WindowDesk';

const api = vi.fn();
let me = { windowDeskEnabled: true, permissions: ['window_desk:view'] };
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => api(...args) as unknown }));
vi.mock('@/lib/master-data', () => ({
  useMasterData: () => null,
  useLocationName: () => (id: string) => id,
}));
vi.mock('../StaffShell', () => ({
  useMe: () => me,
  can: (m: { permissions: string[] }, p: string) => m.permissions.includes(p),
}));
vi.mock('../print/PrintLink', () => ({
  PrintLink: ({ href, label }: { href: string; label: string }) => <a href={href}>{label}</a>,
}));
vi.mock('../commercial/Notice', () => ({
  Notice: () => null,
  useFailureText: () => () => 'failed',
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row: WindowDeskBookingDto = {
  bookingId: 'b1',
  bookingNumber: 'BK00077',
  branchId: 'jed',
  shipmentNumber: 'NOL-SHP-2026-000077',
  confirmedAt: '2026-11-05T10:00:00.000Z',
  sender: { name: 'Sender', phone: '+966500000002' },
  receiver: null,
  originLocationId: 'JED',
  destinationLocationId: 'KRT',
  mode: 'ROAD',
  items: [],
  window: {
    id: 'w1',
    code: 'W1',
    name: { ar: 'نافذة', en: 'Window' },
    address: null,
    phone: null,
    mapUrl: null,
    hours: null,
    outletName: 'Outlet A',
  },
  invoice: { number: null, status: 'DRAFT', currency: 'SAR', total: '100.00', balance: '100.00' },
  received: false,
  receipts: [],
  todo: ['receive', 'collect'],
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  api.mockReset();
  me = { windowDeskEnabled: true, permissions: ['window_desk:view'] };
});

async function render() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<WindowDesk />));
  await act(() => Promise.resolve());
  return host;
}

/** Plan 13 section 2: the window's list of the goods it will receive. */
describe('WindowDesk', () => {
  it('lists the expected bookings with what is owed and left to do', async () => {
    api.mockResolvedValue([row]);
    const el = await render();
    expect(api).toHaveBeenCalledWith('/window-desk/expected?status=expected');
    expect(el.textContent).toContain('BK00077');
    expect(el.textContent).toContain('100.00 / 100.00 SAR');
    expect(el.textContent).toContain('todo_receive · todo_collect');
  });

  it('offers the receipt only with window_desk:create', async () => {
    api.mockResolvedValue([row]);
    const el = await render();
    const buttons = (h: HTMLElement) => [...h.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons(el)).not.toContain('receive');
    act(() => root!.unmount());
    host!.remove();
    me = { windowDeskEnabled: true, permissions: ['window_desk:view', 'window_desk:create'] };
    const again = await render();
    expect(buttons(again)).toContain('receive');
  });

  it('receives the goods and lists the GRN with its printout', async () => {
    me = { windowDeskEnabled: true, permissions: ['window_desk:view', 'window_desk:create'] };
    api.mockResolvedValueOnce([row]);
    const el = await render();
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent === 'receive')!;
    act(() => open.click());
    const form = el.querySelector('form.card')!;
    (form.querySelector('input[name=packages]') as HTMLInputElement).value = '2';
    const received: WindowDeskBookingDto = {
      ...row,
      received: true,
      todo: ['collect'],
      receipts: [
        {
          id: 'm1',
          number: 'NOL-GRN-2026-000009',
          occurredAt: '2026-11-06T08:00:00.000Z',
          packages: 2,
          weightKg: null,
          condition: 'GOOD',
          partyName: 'Sender',
          partyIdType: null,
          partyIdNumber: null,
          note: null,
          createdByName: 'Window clerk',
        },
      ],
    };
    api.mockResolvedValueOnce(received);
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(() => Promise.resolve());
    expect(api).toHaveBeenLastCalledWith('/window-desk/bookings/b1/receipt', {
      method: 'POST',
      body: expect.objectContaining({
        packages: 2,
        condition: 'GOOD',
        partyName: 'Sender',
      }) as unknown,
    });
    expect(el.querySelector('form.card')).toBeNull();
    const link = el.querySelector('a[href="/window-desk/b1/receipts/m1"]');
    expect(link?.textContent).toBe('printGrn');
    expect(el.textContent).not.toContain('todo_receive');
  });

  it('asks nothing while the switch is off or without the permission', async () => {
    me = { windowDeskEnabled: false, permissions: ['window_desk:view'] };
    expect((await render()).textContent).toContain('noAccess');
    expect(api).not.toHaveBeenCalled();
  });
});
