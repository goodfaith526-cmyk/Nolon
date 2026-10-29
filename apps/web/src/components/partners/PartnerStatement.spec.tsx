// @vitest-environment jsdom
import type { PartnerStatementDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let failNext = false;
let data: PartnerStatementDto;
const statement = (over: Partial<PartnerStatementDto> = {}): PartnerStatementDto => ({
  id: 'st1',
  number: 'NOL-PST-2026-000001',
  partnerId: 'p1',
  partnerNumber: 'PRT-0001',
  partnerName: 'Outlet',
  branchId: 'b1',
  branchCode: 'PTS',
  currency: 'USD',
  periodTo: '2026-10-28',
  total: '30',
  totalUsd: '30',
  status: 'DRAFT',
  billId: null,
  billNumber: null,
  billStatus: null,
  createdAt: '2026-10-29T05:00:00.000Z',
  lines: [
    {
      shipmentId: 's1',
      shipmentNumber: 'BK00001',
      role: 'SALES_OUTLET',
      kind: 'ACCRUAL',
      date: '2026-10-28',
      event: 'INVOICED',
      basis: 'PERCENT_OF_PRICE',
      value: '10',
      base: '300',
      quantity: null,
      amount: '30',
      amountUsd: '30',
      reason: null,
    },
  ],
  actions: { canBill: true, canCancel: true },
  ...over,
});

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, ...init });
    if (init?.method && failNext) {
      failNext = false;
      return Promise.reject(new Error('network'));
    }
    return Promise.resolve(data);
  },
}));
vi.mock('../finance/common', async () => {
  const { useEffect, useState } = await import('react');
  return {
    Money: ({ value }: { value: string }) => value,
    useRecord: () => {
      const [record, setRecord] = useState<PartnerStatementDto | null>(null);
      useEffect(() => setRecord(data), []);
      return { record, notice: null, status: null, setRecord };
    },
  };
});
vi.mock('../print/PrintLink', () => ({ PrintLink: () => null }));
const failure = () => 'x';
vi.mock('../commercial/Notice', () => ({ Notice: () => null, useFailureText: () => failure }));
const { PartnerStatement } = await import('./PartnerStatement');

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
  act(() => root.render(<PartnerStatement id="st1" />));
  await act(() => Promise.resolve());
  return host;
}

const buttons = (shown: HTMLElement, text: string) =>
  [...shown.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('PartnerStatement', () => {
  it('shows its lines and makes its bill, retrying a failed press with the same request id', async () => {
    data = statement();
    failNext = true;
    const shown = await show();
    expect(shown.textContent).toContain('BK00001');
    expect(shown.textContent).toContain('basisValue_PERCENT_OF_PRICE');
    act(() => buttons(shown, 'makeBill')[0]?.click());
    const form = shown.querySelector('form');
    if (!form) throw new Error('no bill form');
    act(() => form.requestSubmit());
    await act(() => Promise.resolve());
    act(() => form.requestSubmit());
    await act(() => Promise.resolve());
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual([
      '/partner-statements/st1/bill',
      '/partner-statements/st1/bill',
    ]);
    const [first, second] = posts.map((c) => c.body as { requestId: string; billDate: string });
    expect(first?.requestId).toBe(second?.requestId);
    expect(first?.billDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('offers neither the bill nor the cancellation where the API does not allow them', async () => {
    data = statement({
      status: 'BILLED',
      billId: 'bill1',
      actions: { canBill: false, canCancel: false },
    });
    const shown = await show();
    expect(buttons(shown, 'makeBill')).toHaveLength(0);
    expect(buttons(shown, 'cancel')).toHaveLength(0);
  });
});
