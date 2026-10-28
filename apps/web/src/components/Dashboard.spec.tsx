// @vitest-environment jsdom
import type { DashboardDto } from '@nolon/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let data: DashboardDto;
const NONE: DashboardDto = {
  customers: null,
  rates: null,
  quotations: null,
  bookings: null,
  warehouse: null,
  customs: null,
  trips: null,
  drafts: null,
  alerts: null,
};

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
vi.mock('@/lib/api', () => ({ api: () => Promise.resolve(data) }));
vi.mock('@/lib/master-data', () => ({
  isPlace: (l: { kind?: string }) => l.kind !== 'COUNTRY',
  useMasterData: () => null,
  useLocationName: () => () => '',
}));
vi.mock('./MoreMenu', () => ({ MoreMenu: ({ children }: { children: ReactNode }) => children }));
vi.mock('./StaffShell', () => ({
  useMe: () => ({
    fullName: 'Test',
    roles: [],
    allBranches: false,
    branches: [],
    permissions: ['customers:create'],
  }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { Dashboard } = await import('./Dashboard');

let host: HTMLElement | null = null;

async function show(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Dashboard />));
  await act(() => Promise.resolve()); // the figures load
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
});

describe('Home page', () => {
  it('opens the new-customer form from "New customer"', async () => {
    data = NONE;
    const page = await show();
    const hrefs = [...page.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/customers?new=1');
    // No figures of the user's own work when the API sends none.
    expect(page.querySelector('[role="group"]')).toBeNull();
  });

  it('shows the figures the API sent for the user’s roles, and only those', async () => {
    data = {
      ...NONE,
      trips: { planned: 2, onTheRoad: 1, ownOnly: true },
      drafts: { awaitingReview: 3 },
      alerts: { total: 4, byKind: [{ kind: 'TRIP_LATE', count: 4 }] },
    };
    const page = await show();
    const group = page.querySelector('[role="group"]')!;
    const hrefs = [...group.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/drafts', '/alerts', '/trips']);
    expect(group.textContent).toContain('myTripsOnTheRoad');
    expect(group.textContent).not.toContain('warehouseShipments');
    expect(group.textContent).not.toContain('openCustomsFiles');
  });
});
