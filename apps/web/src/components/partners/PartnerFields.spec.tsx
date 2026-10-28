// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const place = (id: string, countryCode: string, kind = 'PORT') => ({
  id,
  code: id.toUpperCase(),
  kind,
  nameEn: id,
  nameAr: id,
  countryCode,
  cityId: null,
  isActive: true,
});
let permissions: string[] = [];

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/master-data', () => ({
  isPlace: (l: { kind?: string }) => l.kind !== 'COUNTRY',
  useMasterData: () => ({
    currencies: [{ code: 'USD', isActive: true }],
    locations: [place('jed', 'SA'), place('ruh', 'SA', 'CITY'), place('dxb', 'AE')],
  }),
  useLocalName: () => (l: { nameEn: string }) => l.nameEn,
  useLocationName: () => (id: string) => id,
}));
vi.mock('@/lib/api', () => ({ api: () => Promise.resolve(null) }));
vi.mock('../commercial/Notice', () => ({ Notice: () => null, useFailureText: () => () => 'x' }));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions, branches: [] }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { PartnerFields } = await import('./Partners');

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
  permissions = [];
});

function show(): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<PartnerFields />));
  return host;
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('PartnerFields country and city', () => {
  it('picks the country by name, the countries in use first, with no free-text box', () => {
    const shown = show();
    expect(shown.querySelector('input[name="countryCode"]')).toBeNull();
    const country = shown.querySelector<HTMLSelectElement>('select[name="countryCode"]')!;
    expect(country.required).toBe(true);
    const groups = [...country.querySelectorAll('optgroup')];
    expect(groups.map((g) => g.label)).toEqual(['countriesInUse', 'allCountries']);
    expect([...groups[0]!.querySelectorAll('option')].map((o) => o.value)).toEqual(['SA', 'AE']);
    expect(groups[0]!.querySelector('option[value="SA"]')!.textContent).toBe('Saudi Arabia (SA)');
    expect(groups[1]!.querySelector('option[value="SD"]')!.textContent).toBe('Sudan (SD)');
  });

  it('offers only the chosen country’s places, and clears the place when the country changes', () => {
    const shown = show();
    const country = shown.querySelector<HTMLSelectElement>('select[name="countryCode"]')!;
    const place = shown.querySelector<HTMLSelectElement>('select[name="locationId"]')!;
    expect(place.disabled).toBe(true);
    expect(shown.textContent).toContain('chooseCountryFirst');
    choose(country, 'SA');
    expect(place.disabled).toBe(false);
    // Places and cities of Saudi Arabia; never its country-wide pricing scope.
    expect([...place.options].map((o) => o.value)).toEqual(['', 'jed', 'ruh']);
    choose(place, 'jed');
    choose(country, 'AE');
    expect(place.value).toBe('');
    expect([...place.options].map((o) => o.value)).toEqual(['', 'dxb']);
  });

  it('says when a country has no place yet, and links to add one only for those who may', () => {
    const shown = show();
    const country = shown.querySelector<HTMLSelectElement>('select[name="countryCode"]')!;
    choose(country, 'SD');
    expect(shown.querySelector<HTMLSelectElement>('select[name="locationId"]')!.disabled).toBe(
      true,
    );
    expect(shown.textContent).toContain('noPlacesInCountry');
    expect(shown.textContent).not.toContain('addPlace');
    host?.remove();
    permissions = ['master_data:create'];
    const again = show();
    choose(again.querySelector<HTMLSelectElement>('select[name="countryCode"]')!, 'SD');
    expect(again.textContent).toContain('addPlace');
  });

  it('keeps the browser’s saved personal details out of the partner’s fields', () => {
    const shown = show();
    for (const name of ['name', 'phone', 'email']) {
      expect(shown.querySelector(`input[name="${name}"]`)!.getAttribute('autocomplete')).toBe(
        'off',
      );
    }
  });
});
