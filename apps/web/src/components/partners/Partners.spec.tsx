// @vitest-environment jsdom
import type { Page, PartnerSummaryDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const row = (n: number): PartnerSummaryDto => ({
  id: `p${n}`,
  number: `NOL-PTR-00000${n}`,
  kind: 'SALES_OUTLET',
  branchId: 'b1',
  name: `Outlet ${n}`,
  phone: null,
  countryCode: 'SA',
  locationId: null,
  isActive: true,
});

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/master-data', () => ({
  useMasterData: () => null,
  useLocalName: () => (l: { nameEn: string }) => l.nameEn,
  useLocationName: () => (id: string) => id,
}));
vi.mock('@/lib/api', () => ({
  api: (path: string) => {
    calls.push(path);
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
    const result: Page<PartnerSummaryDto> = {
      items: page === 1 ? Array.from({ length: 50 }, (_, i) => row(i + 1)) : [row(51)],
      total: 51,
      page,
      pageSize: 50,
    };
    return Promise.resolve(result);
  },
}));
// Stable, as the real hook is: the list reloads when it changes.
const failure = () => 'x';
vi.mock('../commercial/Notice', () => ({ Notice: () => null, useFailureText: () => failure }));
vi.mock('../StaffShell', () => ({
  useMe: () => ({
    permissions: ['partners:view'],
    branches: [{ id: 'b1', nameEn: 'Jeddah', nameAr: 'جدة' }],
  }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { Partners } = await import('./Partners');

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
  calls.length = 0;
});

describe('Partners', () => {
  it('loads the 51st partner below the first 50, with the same filters', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Partners />));
    await act(() => Promise.resolve());
    expect(host.querySelectorAll('tbody tr')).toHaveLength(50);
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'loadMore');
    act(() => more?.click());
    await act(() => Promise.resolve());
    expect(calls.at(-1)).toContain('page=2');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(51);
    // Every row is shown: no more button.
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'loadMore')).toBe(
      false,
    );
  });
});
