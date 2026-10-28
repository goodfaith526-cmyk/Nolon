// @vitest-environment jsdom
import type { PartnerContractDto, PartnerDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; method?: string; body?: unknown }[] = [];
let permissions = ['partner_contracts:view', 'partner_contracts:create'];
const contract = (id: string, over: Partial<PartnerContractDto>): PartnerContractDto => ({
  id,
  partnerId: 'p1',
  priceCategoryCode: null,
  basis: 'PERCENT_OF_PRICE',
  value: '7.5',
  unit: null,
  currency: null,
  validFrom: '2026-10-01',
  validTo: null,
  notes: null,
  status: 'DRAFT',
  approvedAt: null,
  createdAt: '2026-10-28T00:00:00.000Z',
  actions: { canEdit: true, canApprove: true, canCancel: true },
  ...over,
});
const contracts = [
  contract('c1', {}),
  contract('c2', {
    status: 'CANCELLED',
    actions: { canEdit: false, canApprove: false, canCancel: false },
  }),
];

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/master-data', () => ({
  useMasterData: () => null,
  useLocalName: () => (l: { nameEn: string }) => l.nameEn,
}));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, ...init });
    return Promise.resolve(init?.method ? {} : contracts);
  },
}));
vi.mock('../finance/common', () => ({ Money: ({ value }: { value: string }) => value }));
vi.mock('../StatusBadge', () => ({ StatusBadge: ({ status }: { status: string }) => status }));
const failure = () => 'x';
vi.mock('../commercial/Notice', () => ({ Notice: () => null, useFailureText: () => failure }));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { PartnerContracts } = await import('./PartnerContracts');

const partner = { id: 'p1', currency: 'SAR' } as PartnerDto;
let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
  calls.length = 0;
  permissions = ['partner_contracts:view', 'partner_contracts:create'];
});

async function show(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<PartnerContracts partner={partner} />));
  await act(() => Promise.resolve());
  return host;
}

const buttons = (shown: HTMLElement, text: string) =>
  [...shown.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('PartnerContracts', () => {
  it('offers approve and cancel only where the API allows them', async () => {
    const shown = await show();
    expect(shown.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(buttons(shown, 'approve')).toHaveLength(1);
    expect(buttons(shown, 'cancel')).toHaveLength(1);
    act(() => buttons(shown, 'approve')[0]?.click());
    await act(() => Promise.resolve());
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/partner-contracts/c1/approve');
  });

  it('sends a percentage contract without a unit or currency', async () => {
    const shown = await show();
    act(() => buttons(shown, 'add')[0]?.click());
    const set = (name: string, value: string) => {
      const input = shown.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (input) input.value = value;
    };
    set('value', '5');
    set('validFrom', '2026-11-01');
    act(() => {
      shown
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(() => Promise.resolve());
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      path: '/partners/p1/contracts',
      method: 'POST',
      body: {
        priceCategoryCode: null,
        basis: 'PERCENT_OF_PRICE',
        value: '5',
        unit: null,
        currency: null,
        validFrom: '2026-11-01',
        validTo: null,
        notes: null,
      },
    });
  });

  it('hides the add button without the create permission', async () => {
    permissions = ['partner_contracts:view'];
    expect(buttons(await show(), 'add')).toHaveLength(0);
  });
});
