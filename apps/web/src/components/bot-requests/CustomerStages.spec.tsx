// @vitest-environment jsdom
import type { CustomerStagesDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; init?: { method?: string; body?: unknown } }[] = [];
const data: CustomerStagesDto = {
  stages: [
    { code: 'A1', nameAr: 'أ', nameEn: 'E A', sortOrder: 1, isActive: true },
    { code: 'B1', nameAr: 'ب', nameEn: 'E B', sortOrder: 2, isActive: false },
  ],
  mapping: [
    { status: 'CREATED', stageCode: 'A1' },
    { status: 'ON_HOLD', stageCode: null },
  ],
};

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    return Promise.resolve(init?.method === 'PUT' ? data.stages[1] : data);
  },
}));
vi.mock('../commercial/Notice', () => ({ Notice: () => null, useFailureText: () => () => 'x' }));
const { CustomerStages } = await import('./CustomerStages');

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
  act(() => root.render(<CustomerStages editable />));
  await act(() => Promise.resolve());
  return host;
}
const editButtons = (h: HTMLElement) =>
  [...h.querySelectorAll('button')].filter((b) => b.textContent === 'edit');

describe('CustomerStages', () => {
  it('starts a fresh form when another stage is edited (F164-2)', async () => {
    const shown = await show();
    act(() => editButtons(shown)[0]!.click());
    const nameEn = shown.querySelector<HTMLInputElement>('input[name="nameEn"]')!;
    const order = shown.querySelector<HTMLInputElement>('input[name="sortOrder"]')!;
    const active = shown.querySelector<HTMLInputElement>('input[name="isActive"]')!;
    nameEn.value = 'Changed A';
    order.value = '9';
    active.checked = false;
    act(() => editButtons(shown)[1]!.click());
    await act(async () => {
      shown.querySelector('form')!.requestSubmit();
      await Promise.resolve();
    });
    expect(calls.find((c) => c.init?.method === 'PUT')).toEqual({
      path: '/customer-stages/B1',
      init: {
        method: 'PUT',
        body: { nameAr: 'ب', nameEn: 'E B', sortOrder: 2, isActive: false },
      },
    });
  });

  it('never offers a stage for a status that always goes to staff (F164-1)', async () => {
    const shown = await show();
    const selects = [...shown.querySelectorAll<HTMLSelectElement>('select')];
    expect(selects.map((s) => s.disabled)).toEqual([false, true]);
  });
});
