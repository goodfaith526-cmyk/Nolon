// @vitest-environment jsdom
import type { PartnerCommissionsDto, PartnerDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let data: PartnerCommissionsDto;
const page = (over: Partial<PartnerCommissionsDto> = {}): PartnerCommissionsDto => ({
  partnerId: 'p1',
  balances: [{ branchId: 'b1', branchCode: 'PTS', currency: 'USD', open: '27.5', openUsd: '27.5' }],
  rows: [
    {
      id: 'r1',
      shipmentId: 's1',
      shipmentNumber: 'BK00001',
      branchCode: 'PTS',
      role: 'SALES_OUTLET',
      kind: 'ACCRUAL',
      currency: 'USD',
      amount: '30',
      amountUsd: '30',
      base: '300',
      quantity: null,
      entryNumber: 'NOL-JE-2026-000001',
      statementId: null,
      reason: null,
      createdAt: '2026-10-29T05:00:00.000Z',
    },
  ],
  holds: [
    {
      shipmentId: 's2',
      shipmentNumber: 'BK00002',
      role: 'ORIGIN_CONSOLIDATOR',
      code: 'COMMISSION_NO_FX_RATE',
      detail: null,
      updatedAt: '2026-10-29T05:00:00.000Z',
      canRecompute: true,
    },
  ],
  canAdjust: true,
  ...over,
});

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/lib/master-data', () => ({ useMasterData: () => null }));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, ...init });
    return Promise.resolve(init?.method ? {} : data);
  },
}));
vi.mock('../finance/common', () => ({ Money: ({ value }: { value: string }) => value }));
const failure = () => 'x';
vi.mock('../commercial/Notice', () => ({ Notice: () => null, useFailureText: () => failure }));
const { PartnerCommissions } = await import('./PartnerCommissions');

const partner = { id: 'p1', currency: 'USD', kind: 'SALES_OUTLET' } as PartnerDto;
let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
  calls.length = 0;
});

async function show(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<PartnerCommissions partner={partner} />));
  await act(() => Promise.resolve());
  return host;
}

const buttons = (shown: HTMLElement, text: string) =>
  [...shown.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('PartnerCommissions', () => {
  it('shows the open balance, the holds and the rows, and computes a hold again', async () => {
    data = page();
    const shown = await show();
    expect(shown.textContent).toContain('27.5');
    expect(shown.textContent).toContain('hold_COMMISSION_NO_FX_RATE');
    expect(shown.textContent).toContain('NOL-JE-2026-000001');
    act(() => buttons(shown, 'recompute')[0]?.click());
    await act(() => Promise.resolve());
    expect(calls.find((c) => c.method === 'POST')?.path).toBe(
      '/shipments/s2/commissions/recompute',
    );
  });

  it('offers neither the adjustment nor the recompute where the API does not allow them', async () => {
    data = page({
      canAdjust: false,
      holds: page().holds.map((h) => ({ ...h, canRecompute: false })),
    });
    const shown = await show();
    expect(buttons(shown, 'adjust')).toHaveLength(0);
    expect(buttons(shown, 'recompute')).toHaveLength(0);
  });
});
