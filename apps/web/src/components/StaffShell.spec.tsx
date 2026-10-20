// @vitest-environment jsdom
import type { AuthMeResponse, Permission } from '@nolon/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let permissions: Permission[] = [];
const router = { replace: () => {} };

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  usePathname: () => '/dashboard',
  useRouter: () => router,
}));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: () =>
    Promise.resolve({
      id: 'u1',
      email: 'finance@nolon.test',
      fullName: 'Finance',
      preferredLocale: 'en',
      roles: ['FINANCE'],
      permissions,
      allBranches: false,
      branches: [],
      assistantUrl: null,
    } as unknown as AuthMeResponse),
}));
vi.mock('./alerts/Alerts', () => ({ AlertsBell: () => null }));
const { StaffShell } = await import('./StaffShell');

let host: HTMLElement | null = null;

async function links(): Promise<string[]> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<StaffShell>page</StaffShell>));
  await act(() => Promise.resolve()); // the session loads
  return [...host.querySelectorAll<HTMLAnchorElement>('nav a')].map(
    (a) => a.getAttribute('href') ?? '',
  );
}

afterEach(() => {
  host?.remove();
  host = null;
});

describe('StaffShell menu', () => {
  it('lists the reports, not the trial balance on its own (it is a card of the reports)', async () => {
    permissions = ['financial_reports:view', 'operational_reports:view'];
    const shown = await links();
    expect(shown).toContain('/reports');
    expect(shown).not.toContain('/accounting/trial-balance');
  });
});
