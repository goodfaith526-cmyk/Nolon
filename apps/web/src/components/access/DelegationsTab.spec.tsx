// @vitest-environment jsdom
import type {
  AccessCatalogDto,
  BranchAccessDto,
  DelegationChangeDto,
  DelegationDto,
  Permission,
} from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

interface Call {
  path: string;
  method: string;
  body: unknown;
}
const calls: Call[] = [];

const delegation: DelegationDto = {
  id: 'd1',
  branchId: 'b1',
  delegate: { userId: 'u-mgr', fullName: 'Manager' },
  permissions: ['customers:create', 'customers:view'],
  createdAt: '2026-10-01T08:00:00.000Z',
  grantedCount: 2,
};
const branch: BranchAccessDto = {
  branchId: 'b1',
  blocked: [],
  people: [{ userId: 'u-mgr', fullName: 'Manager', roles: ['BRANCH_MANAGER'], isActive: true }],
  delegations: [delegation],
};
const change: DelegationChangeDto = {
  delegation,
  dropped: [{ userId: 'u-sales', fullName: 'Sami', permission: 'customers:create' }],
};

vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (path: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body });
    if (path === '/access-control/branches/b1') return Promise.resolve(branch);
    return Promise.resolve(change);
  },
}));
const { DelegationsTab } = await import('./DelegationsTab');

const catalog: AccessCatalogDto = {
  modules: ['customers', 'rates'],
  actions: ['view', 'create', 'update', 'approve', 'cancel'],
  grantable: ['customers:view', 'customers:create', 'rates:view'] satisfies Permission[],
  teams: [],
  branches: [{ id: 'b1', code: 'JED', nameAr: 'جدة', nameEn: 'Jeddah' }],
};

let host: HTMLElement | null = null;

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  host?.remove();
  host = null;
});

async function show(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<DelegationsTab catalog={catalog} canEdit />));
  const select = host.querySelector('select');
  if (!select) throw new Error('no branch picker');
  await act(async () => {
    select.value = 'b1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  return host;
}

const button = (shown: HTMLElement, label: string) =>
  [...shown.querySelectorAll('button')].find((b) => b.textContent === label);
const box = (shown: HTMLElement, permission: Permission) =>
  shown.querySelector<HTMLInputElement>(`input[value="${permission}"]`);
const writes = () => calls.filter((c) => c.method !== 'GET');

async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('nothing to click');
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

describe('DelegationsTab', () => {
  it('previews a smaller ceiling, shows what drops, and applies it only on confirm', async () => {
    const shown = await show();
    await click(button(shown, 'changeCeiling'));
    await click(box(shown, 'customers:create'));
    await click(button(shown, 'save'));

    expect(writes()).toEqual([
      {
        path: '/access-control/delegations/d1/preview',
        method: 'POST',
        body: { permissions: ['customers:view'] },
      },
    ]);
    expect(shown.querySelector('[role="alertdialog"]')?.textContent).toContain('Sami');

    await click(button(shown, 'confirmShrink'));
    expect(writes().at(-1)).toEqual({
      path: '/access-control/delegations/d1/permissions',
      method: 'PUT',
      body: { permissions: ['customers:view'] },
    });
  });

  it('sends nothing when the owner cancels the preview', async () => {
    const shown = await show();
    await click(button(shown, 'revoke'));
    expect(writes()).toEqual([
      {
        path: '/access-control/delegations/d1/preview',
        method: 'POST',
        body: { permissions: null },
      },
    ]);
    await click(button(shown, 'cancel'));
    expect(writes()).toHaveLength(1);
    expect(shown.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('revokes only after the preview is confirmed', async () => {
    const shown = await show();
    await click(button(shown, 'revoke'));
    await click(button(shown, 'confirmRevoke'));
    expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /access-control/delegations/d1/preview',
      'POST /access-control/delegations/d1/revoke',
    ]);
  });

  it('applies a ceiling that only grows without a preview', async () => {
    const shown = await show();
    await click(button(shown, 'changeCeiling'));
    await click(box(shown, 'rates:view'));
    await click(button(shown, 'save'));
    expect(writes()).toEqual([
      {
        path: '/access-control/delegations/d1/permissions',
        method: 'PUT',
        body: { permissions: ['customers:create', 'customers:view', 'rates:view'] },
      },
    ]);
  });
});
