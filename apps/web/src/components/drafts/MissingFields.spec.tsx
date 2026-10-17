// @vitest-environment jsdom
import type { DraftActions } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const translate = Object.assign((key: string) => key, { has: () => false });
vi.mock('next-intl', () => ({ useTranslations: () => translate, useLocale: () => 'en' }));
const api = vi.fn();
vi.mock('@/lib/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('@/lib/master-data', () => ({
  useMasterData: () => null,
  useLocalName: () => (item: { nameEn: string }) => item.nameEn,
  failureStatus: () => 0,
}));
vi.mock('../finance/reports/ReportKit', () => ({ useApiList: () => null }));
const { MissingFields } = await import('./MissingFields');

interface Draft {
  id: string;
  version: number;
  missingFields: string[];
  actions: DraftActions;
  request: object;
}

let host: HTMLElement | null = null;

function show(draft: Draft, onChanged: (d: Draft) => void = () => undefined): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(<MissingFields draft={draft} apiPath="/rate-card-drafts" onChanged={onChanged} />),
  );
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
  api.mockReset();
});

const draft: Draft = {
  id: 'd1',
  version: 3,
  missingFields: ['mode', 'price'],
  actions: { canEdit: true, canDecide: true },
  request: {},
};

describe('MissingFields', () => {
  it('shows nothing for a complete draft', () => {
    expect(show({ ...draft, missingFields: [] }).textContent).toBe('');
  });

  it('lists what is missing, without a form on a draft that cannot be edited', () => {
    const el = show({ ...draft, actions: { canEdit: false, canDecide: false } });
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['mode', 'price']);
    expect(el.querySelector('form')).toBeNull();
  });

  it('sends the values typed with the version on screen, and shows the answer', async () => {
    const answer = { ...draft, version: 4, missingFields: [] };
    api.mockResolvedValue(answer);
    const onChanged = vi.fn();
    const el = show(draft, onChanged);
    const select = el.querySelector('select');
    const input = el.querySelector<HTMLInputElement>('input');
    if (!select || !input) throw new Error('form not shown');
    const set = (control: HTMLInputElement | HTMLSelectElement, value: string) => {
      const proto = Object.getPrototypeOf(control) as object;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(control, value);
      control.dispatchEvent(
        new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
      );
    };
    act(() => {
      set(select, 'SEA');
      set(input, '١٢٫٥');
    });
    await act(async () => {
      el.querySelector('form')?.requestSubmit();
      await Promise.resolve();
    });
    expect(api).toHaveBeenCalledWith('/rate-card-drafts/d1', {
      method: 'PATCH',
      body: { mode: 'SEA', price: '12.5', version: 3 },
    });
    expect(onChanged).toHaveBeenCalledWith(answer);
  });
});
