// @vitest-environment jsdom
import type { MasterDataDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let permissions: string[] = [];
const calls: { path: string; init?: { method?: string; body?: unknown } }[] = [];
const data = {
  branches: [],
  locations: [],
  containerTypes: [{ code: '20GP', nameEn: '20 ft', nameAr: '20 قدم', isActive: true }],
  chargeTypes: [{ code: 'THC', nameEn: 'THC', nameAr: 'مناولة', isActive: false }],
  documentTypes: [],
  currencies: [
    {
      code: 'SDG',
      nameEn: 'Sudanese pound',
      nameAr: 'جنيه سوداني',
      isActive: true,
      symbol: null,
      decimalPlaces: 2,
    },
  ],
  priceCategories: [
    {
      code: 'CARTON',
      nameEn: 'Carton / parcel',
      nameAr: 'كرتون / طرد',
      isActive: true,
      cargoType: 'GENERAL',
      defaultUnit: 'PER_PIECE',
    },
  ],
  customerSegments: [],
} satisfies MasterDataDto;

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/master-data', () => ({ useLocalName: () => (l: { nameEn: string }) => l.nameEn }));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    return Promise.resolve(init ? {} : data);
  },
}));
vi.mock('./Notice', () => ({ Notice: () => null, useFailureText: () => () => 'failed' }));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { MasterData } = await import('./MasterData');

let host: HTMLElement | null = null;

async function show(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<MasterData />));
  await act(() => Promise.resolve()); // the lists load
  return host;
}

/** The tab panel of a list, by its tab's label (the message key here). */
function panel(shown: HTMLElement, label: string): HTMLElement {
  const tab = [...shown.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (t) => t.textContent === label,
  );
  const id = tab?.getAttribute('aria-controls');
  const found = id ? document.getElementById(id) : null;
  if (!found) throw new Error(`No panel ${label}`);
  return found;
}

function click(element: Element | null | undefined) {
  act(() => {
    (element as HTMLElement).click();
  });
}

afterEach(() => {
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  calls.length = 0;
  window.history.replaceState(null, '', '#');
});

describe('MasterData', () => {
  it('shows the six lists as tabs, each with its entries and status', async () => {
    permissions = ['master_data:view'];
    const shown = await show();
    expect([...shown.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
      'containerTypes',
      'chargeTypes',
      'documentTypes',
      'currencies',
      'priceCategories',
      'customerSegments',
    ]);
    expect(panel(shown, 'containerTypes').textContent).toContain('20GP');
    expect(panel(shown, 'chargeTypes').querySelector('tr.inactive')?.textContent).toContain('THC');
    expect(panel(shown, 'documentTypes').textContent).toContain('none');
    // View only: no add form, no edit or deactivate buttons.
    expect(shown.querySelector('form')).toBeNull();
    expect(shown.querySelector('tbody button')).toBeNull();
  });

  it('adds a currency with its decimal places, and an entry without them', async () => {
    permissions = ['master_data:view', 'master_data:create'];
    const shown = await show();
    const form = panel(shown, 'currencies').querySelector('form')!;
    const set = (name: string, value: string) => {
      form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value = value;
    };
    set('code', 'gbp');
    set('nameAr', 'جنيه');
    set('nameEn', 'Pound');
    set('symbol', '£');
    set('decimalPlaces', '2');
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({
      path: '/master-data/currencies',
      init: {
        method: 'POST',
        body: { code: 'GBP', nameEn: 'Pound', nameAr: 'جنيه', symbol: '£', decimalPlaces: 2 },
      },
    });
    expect(panel(shown, 'containerTypes').querySelector('input[name="decimalPlaces"]')).toBeNull();
  });

  it('renames without the code, and deactivates and reactivates by code', async () => {
    permissions = ['master_data:view', 'master_data:update'];
    const shown = await show();
    const containers = panel(shown, 'containerTypes');
    const [edit, deactivate] = containers.querySelectorAll('tbody button');
    click(deactivate);
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({
      path: '/master-data/container-types/20GP/deactivate',
      init: { method: 'POST' },
    });
    click(panel(shown, 'chargeTypes').querySelectorAll('tbody button')[1]);
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({
      path: '/master-data/charge-types/THC/reactivate',
      init: { method: 'POST' },
    });

    click(edit);
    const dialog = document.querySelector('dialog form')!;
    expect(dialog.querySelector('input[name="code"]')).toBeNull();
    dialog.querySelector<HTMLInputElement>('input[name="nameEn"]')!.value = '20 foot';
    act(() => {
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({
      path: '/master-data/container-types/20GP',
      init: { method: 'PATCH', body: { nameEn: '20 foot', nameAr: '20 قدم' } },
    });
  });

  it('adds a price category with its cargo type and unit, and edits its unit only', async () => {
    permissions = ['master_data:view', 'master_data:create', 'master_data:update'];
    const shown = await show();
    const categories = panel(shown, 'priceCategories');
    expect(categories.textContent).toContain('cargo_GENERAL');
    expect(categories.textContent).toContain('unit_PER_PIECE');
    const form = categories.querySelector('form')!;
    const set = (name: string, value: string) => {
      form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!.value = value;
    };
    set('code', 'drum');
    set('nameAr', 'برميل');
    set('nameEn', 'Drum');
    set('cargoType', 'BARREL');
    set('defaultUnit', 'PER_BARREL');
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({
      path: '/master-data/price-categories',
      init: {
        method: 'POST',
        body: {
          code: 'DRUM',
          nameEn: 'Drum',
          nameAr: 'برميل',
          cargoType: 'BARREL',
          defaultUnit: 'PER_BARREL',
        },
      },
    });

    click(categories.querySelectorAll('tbody button')[0]);
    const dialog = document.querySelector('dialog form')!;
    expect(dialog.querySelector('[name="cargoType"]')).toBeNull();
    dialog.querySelector<HTMLSelectElement>('select[name="defaultUnit"]')!.value = 'PER_SHIPMENT';
    act(() => {
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({
      path: '/master-data/price-categories/CARTON',
      init: {
        method: 'PATCH',
        body: { nameEn: 'Carton / parcel', nameAr: 'كرتون / طرد', defaultUnit: 'PER_SHIPMENT' },
      },
    });
  });

  it('says so to a user without master_data:view', async () => {
    permissions = [];
    const shown = await show();
    expect(shown.textContent).toBe('noAccess');
  });
});
