// @vitest-environment jsdom
import type { LocationDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let permissions: string[] = [];
const calls: { path: string; init?: { method?: string; body?: unknown } }[] = [];
const place = (id: string, kind: LocationDto['kind'], cityId: string | null = null) =>
  ({
    id,
    code: id.toUpperCase(),
    kind,
    nameEn: id,
    nameAr: id,
    countryCode: 'AE',
    isActive: true,
    cityId,
  }) satisfies LocationDto;
const locations = [place('dxb', 'CITY'), place('jea', 'PORT')];

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/master-data', () => ({ useLocalName: () => (l: { nameEn: string }) => l.nameEn }));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    return Promise.resolve(init ? {} : { locations });
  },
}));
vi.mock('./Notice', () => ({ Notice: () => null, useFailureText: () => () => 'failed' }));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { Locations } = await import('./Locations');

let host: HTMLElement | null = null;

async function show(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Locations />));
  await act(() => Promise.resolve()); // the list loads
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
  calls.length = 0;
});

describe('Locations', () => {
  it('links a port to its city with the city picker on its row', async () => {
    permissions = ['master_data:view', 'master_data:update'];
    const shown = await show();
    const pickers = shown.querySelectorAll<HTMLSelectElement>('tbody select');
    expect(pickers).toHaveLength(1); // the port's row; a city names no city
    const picker = pickers[0]!;
    act(() => {
      picker.value = 'dxb';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => Promise.resolve());
    expect(calls).toContainEqual({
      path: '/master-data/locations/jea',
      init: { method: 'PATCH', body: { cityId: 'dxb' } },
    });
  });

  it('shows the city as text, and no add form, to those who may only view', async () => {
    permissions = ['master_data:view'];
    locations[1] = place('jea', 'PORT', 'dxb');
    const shown = await show();
    expect(shown.querySelector('select')).toBeNull();
    expect(shown.querySelector('form')).toBeNull();
    expect(shown.querySelector('tbody')?.textContent).toContain('dxb');
  });
});
