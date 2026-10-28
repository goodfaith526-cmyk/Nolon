// @vitest-environment jsdom
import type { AccessCatalogDto, AccessTeamDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: () => Promise.resolve({}),
}));
const { TeamsTab } = await import('./TeamsTab');

const team = (over: Partial<AccessTeamDto>): AccessTeamDto => ({
  id: 't',
  code: 'T',
  nameAr: 'ف',
  nameEn: 'T',
  systemRole: null,
  restricted: false,
  isActive: true,
  permissions: [],
  defaults: null,
  ...over,
});

const catalog: AccessCatalogDto = {
  modules: ['customers', 'rates'],
  actions: ['view', 'create', 'update', 'approve', 'cancel'],
  grantable: ['customers:view', 'customers:create', 'customers:update', 'rates:view'],
  teams: [
    team({
      id: 'sales',
      nameEn: 'Sales',
      systemRole: 'SALES',
      permissions: ['customers:create', 'customers:update', 'customers:view', 'rates:view'],
      defaults: ['customers:create', 'customers:update', 'customers:view'],
    }),
    team({
      id: 'driver',
      nameEn: 'Driver',
      systemRole: 'DRIVER',
      restricted: true,
      permissions: ['rates:view'],
      defaults: ['rates:view'],
    }),
  ],
  branches: [],
};

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function show(): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<TeamsTab catalog={catalog} canEdit onReload={() => {}} />));
  return host;
}

const cells = (shown: HTMLElement) =>
  [...shown.querySelectorAll<HTMLButtonElement>('.access-grid tbody button')].map(
    (b) => `${b.textContent}${b.classList.contains('changed') ? '*' : ''}`,
  );

describe('TeamsTab', () => {
  it('shows each cell’s annex letter and marks a cell changed from the default', () => {
    // Rows: customers, rates; columns: Sales, Driver.
    expect(cells(show())).toEqual(['level_E', 'level_N', 'level_V*', 'level_V']);
  });

  it('shows a restricted team read only', () => {
    const shown = show();
    const driver = [...shown.querySelectorAll('thead button')].find(
      (b) => b.textContent === 'Driver',
    );
    act(() => (driver as HTMLButtonElement).click());
    expect(shown.textContent).toContain('restrictedTeam');
    const boxes = [...shown.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect([...shown.querySelectorAll('button')].some((b) => b.textContent === 'save')).toBe(false);
  });

  it('offers reset to default for a changed system team', () => {
    const shown = show();
    const sales = [...shown.querySelectorAll('thead button')].find(
      (b) => b.textContent === 'Sales',
    );
    act(() => (sales as HTMLButtonElement).click());
    expect(shown.textContent).toContain('resetDefault');
    expect(shown.textContent).toContain('changed');
  });
});
