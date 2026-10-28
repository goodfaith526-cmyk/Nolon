// @vitest-environment jsdom
import type { Page, PartnerSummaryDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
/** When set, replies wait until `release()`: requests in flight. */
let held: (() => void)[] | null = null;
const release = (newestFirst = false) => {
  const waiting = held ?? [];
  held = null;
  for (const go of newestFirst ? waiting.reverse() : waiting) go();
};
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

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
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
    if (!held) return Promise.resolve(result);
    const queue = held;
    return new Promise((resolve) => queue.push(() => resolve(result)));
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
  held = null;
});

async function show(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Partners />));
  await act(() => Promise.resolve());
  return host;
}

const moreButton = (shown: HTMLElement) =>
  [...shown.querySelectorAll('button')].find((b) => b.textContent === 'loadMore');

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

  it('sends the next page once however often it is pressed, and drops a stale page', async () => {
    const shown = await show();
    held = [];
    act(() => moreButton(shown)?.click());
    act(() => moreButton(shown)?.click());
    expect(calls.filter((c) => c.includes('page=2'))).toHaveLength(1);
    expect(moreButton(shown)?.disabled).toBe(true);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(shown.querySelectorAll('tbody tr')).toHaveLength(51);

    // A new search while the next page of the old one is loading: the old page is dropped.
    const fresh = await show();
    held = [];
    act(() => moreButton(fresh)?.click());
    const form = fresh.querySelector('form');
    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    // The new search answers first; the old page arriving after it must not be added.
    await act(async () => {
      release(true);
      await Promise.resolve();
    });
    expect(calls.at(-1)).toContain('page=1');
    expect(fresh.querySelectorAll('tbody tr')).toHaveLength(50);
  });
});
