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
    permissions: ['customers:create', 'customers:view'],
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
    // Nothing to act on that the user may see: no "needs your action" panel.
    expect(page.textContent).not.toContain('needsAction');
  });

  it('shows shortcuts only to the sections the user may view, and no counters', async () => {
    data = {
      ...NONE,
      customers: { total: 13 },
      bookings: { draft: 0, confirmed: 33, recent: [] },
    };
    const page = await show();
    const nav = page.querySelector('nav')!;
    const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/customers']);
    expect(page.textContent).not.toContain('13');
    expect(page.textContent).not.toContain('33');
  });

  it('lists what waits for the user, most pressing first, with where to act', async () => {
    data = {
      ...NONE,
      drafts: { awaitingReview: 3 },
      // Branch- or company-wide counts, not work assigned to this user: never listed.
      rates: { draft: 3, approved: 0 },
      quotations: { draft: 0, sent: 0, approved: 2, recent: [] },
      bookings: { draft: 4, confirmed: 0, recent: [] },
      alerts: {
        total: 6,
        byKind: [
          { kind: 'SHIPMENT_ARRIVING_SOON', count: 2 },
          { kind: 'TRIP_LATE', count: 4 },
        ],
      },
    };
    const page = await show();
    const rows = [...page.querySelectorAll('.attention-list a')];
    expect(rows.map((r) => [r.getAttribute('href'), r.textContent])).toEqual([
      ['/alerts', 'kind_TRIP_LATE4'],
      ['/drafts', 'draftsAwaitingReview3'],
      ['/alerts', 'kind_SHIPMENT_ARRIVING_SOON2'],
    ]);
    expect(page.textContent).not.toContain('draftRates');
    expect(page.textContent).not.toContain('approvedToBook');
    expect(page.textContent).not.toContain('draftBookings');
  });

  it('says nothing waits when the user may see the sources but all are empty', async () => {
    data = { ...NONE, drafts: { awaitingReview: 0 }, alerts: { total: 0, byKind: [] } };
    const page = await show();
    expect(page.querySelector('.attention-list')).toBeNull();
    expect(page.textContent).toContain('allClear');
  });
});
