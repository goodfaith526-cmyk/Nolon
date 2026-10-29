// @vitest-environment jsdom
import type { PaymentInstructionDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; method?: string; body?: unknown }[] = [];
const row = (id: string, over: Partial<PaymentInstructionDto>): PaymentInstructionDto => ({
  id,
  branchId: 'b-jed',
  branchCode: 'JED',
  currency: 'SAR',
  textAr: 'ادفع للحساب',
  textEn: 'Pay to the account',
  status: 'DRAFT',
  version: 2,
  createdById: 'u1',
  createdByName: 'Maker',
  editedByName: 'Maker',
  createdAt: '2026-10-28T00:00:00.000Z',
  approvedByName: null,
  approvedAt: null,
  retiredAt: null,
  actions: { canEdit: true, canApprove: true, canRetire: true },
  ...over,
});
const rows = [
  row('d1', {}),
  row('r1', {
    status: 'RETIRED',
    actions: { canEdit: false, canApprove: false, canRetire: false },
  }),
];
let me = {
  permissions: ['payment_instructions:view'],
  branches: [{ id: 'b-jed', nameEn: 'Jeddah', defaultCurrency: 'SAR' }],
  branchPermissions: [{ branchId: 'b-jed', permissions: ['payment_instructions:view'] }],
};

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/master-data', () => ({
  useMasterData: () => ({ currencies: [{ code: 'SAR', isActive: true }] }),
  useLocalName: () => (l: { nameEn: string }) => l.nameEn,
}));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, ...init });
    return Promise.resolve(init?.method ? {} : rows);
  },
}));
vi.mock('../StatusBadge', () => ({ StatusBadge: ({ status }: { status: string }) => status }));
const failure = () => 'x';
vi.mock('../commercial/Notice', () => ({ Notice: () => null, useFailureText: () => failure }));
vi.mock('../StaffShell', () => ({ useMe: () => me }));
const { PaymentInstructions } = await import('./PaymentInstructions');

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
  act(() => root.render(<PaymentInstructions />));
  await act(() => Promise.resolve());
  return host;
}

const buttons = (shown: HTMLElement, text: string) =>
  [...shown.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('PaymentInstructions', () => {
  it('offers only what the API allows, and sends the version shown', async () => {
    const shown = await show();
    expect(shown.querySelectorAll('article')).toHaveLength(2);
    expect(buttons(shown, 'approve')).toHaveLength(1);
    expect(buttons(shown, 'retire')).toHaveLength(1);
    expect(buttons(shown, 'edit')).toHaveLength(1);
    // No branch to write in: no new draft.
    expect(buttons(shown, 'add')).toHaveLength(0);

    await act(async () => {
      buttons(shown, 'approve')[0]!.click();
      await Promise.resolve();
    });
    expect(calls).toContainEqual({
      path: '/payment-instructions/d1/approve',
      method: 'POST',
      body: { version: 2 },
    });
  });

  it('writes a draft in a branch where the person holds create', async () => {
    me = {
      ...me,
      branchPermissions: [
        {
          branchId: 'b-jed',
          permissions: ['payment_instructions:view', 'payment_instructions:create'],
        },
      ],
    };
    const shown = await show();
    await act(async () => {
      buttons(shown, 'add')[0]!.click();
      await Promise.resolve();
    });
    const form = shown.querySelector('form')!;
    form.querySelector<HTMLTextAreaElement>('textarea[name="textAr"]')!.value = 'نص';
    form.querySelector<HTMLTextAreaElement>('textarea[name="textEn"]')!.value = 'Text';
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(calls).toContainEqual({
      path: '/payment-instructions',
      method: 'POST',
      body: { branchId: 'b-jed', currency: 'SAR', textAr: 'نص', textEn: 'Text' },
    });
  });
});
