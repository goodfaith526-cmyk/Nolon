// @vitest-environment jsdom
import type { ExpectedMarginDto, RateCardCostDto, RateCardDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let permissions = ['rate_costs:view', 'rate_costs:update'];
const costs: RateCardCostDto[] = [
  {
    component: 'SEA_FREIGHT',
    status: 'ENTERED',
    amount: '20',
    currency: 'USD',
    unit: 'PER_CBM',
    unitsPerCostUnit: null,
    note: null,
    updatedAt: '2026-10-28T00:00:00.000Z',
  },
];
const margin: ExpectedMarginDto = {
  rateCardId: 'r1',
  currency: 'USD',
  quantity: null,
  price: '100',
  lines: [
    { component: 'SEA_FREIGHT', amount: '20', notApplicable: false, gap: null },
    { component: 'ORIGIN_HANDLING', amount: null, notApplicable: false, gap: 'NOT_ENTERED' },
    {
      component: 'OUTLET_COMMISSION',
      amount: null,
      notApplicable: false,
      gap: 'OUTLET_NOT_CHOSEN',
    },
  ],
  expectedMargin: null,
  incomplete: true,
  missing: ['ORIGIN_HANDLING', 'OUTLET_COMMISSION'],
  asOf: '2026-10-28',
};

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}(${Object.values(values).join('|')})` : key,
}));
vi.mock('@/lib/master-data', () => ({ useMasterData: () => null }));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, ...init });
    if (path.includes('/expected-margin')) return Promise.resolve(margin);
    return Promise.resolve(costs);
  },
}));
vi.mock('../finance/common', () => ({
  Money: ({ value }: { value: string }) => value,
}));
vi.mock('../partners/PartnerSelect', () => ({ PartnerSelect: () => null }));
const failure = () => 'x';
vi.mock('./Notice', () => ({ Notice: () => null, useFailureText: () => failure }));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions, branches: [{ id: 'b1', nameEn: 'Jeddah', nameAr: 'جدة' }] }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { RateCosts } = await import('./RateCosts');

const rate = { id: 'r1', unit: 'PER_CBM', currency: 'USD', status: 'APPROVED' } as RateCardDto;
let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
  calls.length = 0;
  permissions = ['rate_costs:view', 'rate_costs:update'];
});

async function show(card: RateCardDto = rate): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<RateCosts rate={card} onClose={() => undefined} />));
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  return host;
}

const buttons = (shown: HTMLElement, text: string) =>
  [...shown.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('RateCosts', () => {
  it('shows the margin as incomplete, naming what is missing, never a guessed figure', async () => {
    const shown = await show();
    expect(shown.textContent).toContain(
      'incomplete(component_ORIGIN_HANDLING، component_OUTLET_COMMISSION)',
    );
    expect(shown.textContent).toContain('gap_NOT_ENTERED');
    expect(shown.textContent).toContain('gap_OUTLET_NOT_CHOSEN');
    expect(shown.querySelector('strong')).toBeNull();
  });

  it('saves a component as not applicable', async () => {
    const shown = await show();
    // One edit button per component, in RATE_COST_COMPONENTS order (ORIGIN_HANDLING first).
    act(() => buttons(shown, 'edit')[0]?.click());
    const box = shown.querySelector<HTMLInputElement>('input[type="checkbox"]');
    act(() => box?.click());
    act(() => {
      shown
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(() => Promise.resolve());
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      path: '/rates/r1/costs/ORIGIN_HANDLING',
      method: 'PUT',
      body: { status: 'NOT_APPLICABLE', note: null },
    });
  });

  it('offers no edits without the permission or on a cancelled card', async () => {
    permissions = ['rate_costs:view'];
    expect(buttons(await show(), 'edit')).toHaveLength(0);
    permissions = ['rate_costs:view', 'rate_costs:update'];
    expect(buttons(await show({ ...rate, status: 'CANCELLED' }), 'edit')).toHaveLength(0);
  });
});
