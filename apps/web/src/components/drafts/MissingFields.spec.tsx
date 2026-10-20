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

  // Functional review هـ3/هـ4/هـ5: suggestions, text values, pick lists.
  const setValue = (control: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = Object.getPrototypeOf(control) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  };

  function showWith(props: Record<string, unknown>, d: Draft = draft): HTMLElement {
    host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <MissingFields
          draft={d}
          apiPath="/release-drafts"
          onChanged={() => undefined}
          {...props}
        />,
      ),
    );
    return host;
  }

  it('opens with the suggested values, marked, and sends them only when saved', async () => {
    api.mockResolvedValue(draft);
    const el = showWith(
      {
        choices: { warehouseId: [{ value: 'w1', label: 'W1' }] },
        suggested: { warehouseId: 'w1', packages: '4' },
        dependents: { warehouseId: ['packages'] },
      },
      { ...draft, missingFields: ['warehouseId', 'packages'] },
    );
    expect(el.querySelector('select')?.value).toBe('w1');
    expect(el.querySelector<HTMLInputElement>('input')?.value).toBe('4');
    expect(el.textContent).toContain('missingSuggestedHint');
    expect(el.querySelectorAll('small').length).toBe(2);
    expect(api).not.toHaveBeenCalled();
    await act(async () => {
      el.querySelector('form')?.requestSubmit();
      await Promise.resolve();
    });
    expect(api).toHaveBeenCalledWith('/release-drafts/d1', {
      method: 'PATCH',
      body: { warehouseId: 'w1', packages: 4, version: 3 },
    });
  });

  it('drops a suggestion tied to a value the person changes, but keeps what they typed', () => {
    const d = { ...draft, missingFields: ['warehouseId', 'packages'] };
    const props = {
      choices: {
        warehouseId: [
          { value: 'w1', label: 'W1' },
          { value: 'w2', label: 'W2' },
        ],
      },
      suggested: { warehouseId: 'w1', packages: '4' },
      dependents: { warehouseId: ['packages'] },
    };
    const el = showWith(props, d);
    const select = el.querySelector('select');
    const input = el.querySelector<HTMLInputElement>('input');
    if (!select || !input) throw new Error('form not shown');
    act(() => setValue(select, 'w2'));
    expect(input.value).toBe('');
    host?.remove();
    const again = showWith(props, d);
    const select2 = again.querySelector('select');
    const input2 = again.querySelector<HTMLInputElement>('input');
    if (!select2 || !input2) throw new Error('form not shown');
    act(() => setValue(input2, '2'));
    act(() => setValue(select2, 'w2'));
    expect(input2.value).toBe('2');
  });

  it('keeps a value the person chose even when it equals the suggestion (Codex F97-2)', () => {
    const d = { ...draft, missingFields: ['warehouseId', 'packages'] };
    const el = showWith(
      {
        choices: {
          warehouseId: [
            { value: 'w1', label: 'W1' },
            { value: 'w2', label: 'W2' },
          ],
        },
        suggested: { warehouseId: 'w1', packages: '4' },
        dependents: { warehouseId: ['packages'] },
      },
      d,
    );
    const select = el.querySelector('select');
    const input = el.querySelector<HTMLInputElement>('input');
    if (!select || !input) throw new Error('form not shown');
    act(() => setValue(input, '5'));
    act(() => setValue(input, '4'));
    act(() => setValue(select, 'w2'));
    expect(input.value).toBe('4');
    // Neither value is marked as a suggestion any more.
    expect([...el.querySelectorAll('small')].map((x) => x.textContent)).not.toContain(
      'missingSuggested',
    );
  });

  it('takes a name as text and an invoice from the choices given', () => {
    const el = showWith(
      { choices: { invoiceId: [{ value: 'i1', label: 'INV-1 · 50 USD' }] } },
      { ...draft, missingFields: ['name', 'allocations[0].invoiceId'] },
    );
    const input = el.querySelector<HTMLInputElement>('input');
    expect(input?.type).toBe('text');
    expect(input?.inputMode).toBe('');
    if (input) act(() => setValue(input, 'آمنة ٣'));
    expect(input?.value).toBe('آمنة ٣');
    const options = [...(el.querySelector('select')?.options ?? [])].map((o) => o.value);
    expect(options).toEqual(['', 'i1']);
  });

  it('says when a pick list has nothing to choose from', () => {
    const el = showWith(
      { choices: { cashAccountId: [] } },
      { ...draft, missingFields: ['cashAccountId'] },
    );
    expect(el.textContent).toContain('missingNoChoices');
  });
});
