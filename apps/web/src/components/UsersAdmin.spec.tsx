// @vitest-environment jsdom
import type { UserSummary } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const user = (id: string, roles: UserSummary['roles']): UserSummary => ({
  id,
  email: `${id}@nolon.example`,
  fullName: id,
  preferredLocale: 'ar',
  isActive: true,
  lastLoginAt: null,
  roles,
  branchIds: ['b1'],
  outletIds: roles.includes('OUTLET_STAFF') ? ['o1'] : [],
});
const users = [user('sales', ['SALES']), user('outlet', ['OUTLET_STAFF'])];

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  api: () => Promise.resolve(users),
}));
let assignable = false;
vi.mock('./partners/PartnerSelect', () => ({
  PartnerSelect: ({ branchIds }: { branchIds: string[] }) => `outlets of ${branchIds.join()}`,
}));
vi.mock('./StaffShell', () => ({
  useMe: () => ({
    outletStaffAssignable: assignable,
    permissions: ['users:view', 'users:create', 'users:update'],
    branches: [{ id: 'b1', nameEn: 'Jeddah', nameAr: 'جدة' }],
  }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { UsersAdmin } = await import('./UsersAdmin');

let host: HTMLElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
  assignable = false;
});

async function show(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<UsersAdmin />));
  await act(() => Promise.resolve());
  return host;
}

const roleChoices = (shown: HTMLElement) =>
  [...shown.querySelectorAll<HTMLInputElement>('input[name="roles"]')].map((i) => i.value);

const button = (shown: HTMLElement, label: string, n = 0) =>
  [...shown.querySelectorAll('button')].filter((b) => b.textContent === label)[n];

describe('UsersAdmin', () => {
  it('does not offer the locked Outlet Staff role to a new user or another role', async () => {
    const shown = await show();
    act(() => button(shown, 'add')?.click());
    expect(roleChoices(shown)).not.toContain('OUTLET_STAFF');
    expect(roleChoices(shown)).toContain('SALES');
  });

  it('keeps the role on a user who already holds it', async () => {
    const shown = await show();
    act(() => button(shown, 'edit', 1)?.click());
    const outlet = shown.querySelector<HTMLInputElement>('input[value="OUTLET_STAFF"]');
    expect(outlet?.checked).toBe(true);
  });

  it('offers the role once opened, with the outlet picker of the one branch chosen', async () => {
    assignable = true;
    const shown = await show();
    act(() => button(shown, 'add')?.click());
    expect(roleChoices(shown)).toContain('OUTLET_STAFF');
    expect(shown.textContent).not.toContain('outletHint');
    act(() => shown.querySelector<HTMLInputElement>('input[value="OUTLET_STAFF"]')?.click());
    expect(shown.textContent).toContain('outletOneBranch');
    act(() => shown.querySelector<HTMLInputElement>('input[name="branchIds"]')?.click());
    expect(shown.textContent).toContain('outlets of b1');
  });
});
