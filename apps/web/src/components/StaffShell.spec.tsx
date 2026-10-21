// @vitest-environment jsdom
import type { AuthMeResponse, Permission } from '@nolon/shared';
import { type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let permissions: Permission[] = [];
let assistantUrl: string | null = null;
let assistantPanel = false;
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
      assistantUrl,
      assistantPanel,
    } as unknown as AuthMeResponse),
}));
vi.mock('./alerts/Alerts', () => ({ AlertsBell: () => null }));
const { StaffShell } = await import('./StaffShell');

let host: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<StaffShell>page</StaffShell>));
  await act(() => Promise.resolve()); // the session loads
  return host;
}

async function links(): Promise<string[]> {
  return [...(await render()).querySelectorAll<HTMLAnchorElement>('nav a')].map(
    (a) => a.getAttribute('href') ?? '',
  );
}

afterEach(() => {
  host?.remove();
  host = null;
  assistantUrl = null;
  assistantPanel = false;
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('StaffShell menu', () => {
  it('lists the reports, not the trial balance on its own (it is a card of the reports)', async () => {
    permissions = ['financial_reports:view', 'operational_reports:view'];
    const shown = await links();
    expect(shown).toContain('/reports');
    expect(shown).not.toContain('/accounting/trial-balance');
  });
});

describe('StaffShell assistant', () => {
  const url = 'https://assistant.nolon.example/';

  it('opens the assistant in a new tab when the panel is off', async () => {
    assistantUrl = url;
    const page = await render();
    const link = [...page.querySelectorAll<HTMLAnchorElement>('.topbar a')].find(
      (a) => a.getAttribute('href') === url,
    );
    expect(link?.target).toBe('_blank');
    expect(page.querySelector('iframe')).toBeNull();
  });

  it('opens the panel beside the page, loads it once, and keeps it while closed', async () => {
    assistantUrl = url;
    assistantPanel = true;
    const page = await render();
    const toggle = page.querySelector<HTMLButtonElement>('button[aria-controls="assistant-panel"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    // Nothing loads until the staff member opens it.
    expect(page.querySelector('iframe')).toBeNull();

    act(() => toggle?.click());
    const frame = page.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(url);
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(page.querySelector('#assistant-panel')?.hasAttribute('hidden')).toBe(false);

    act(() => toggle?.click());
    expect(page.querySelector('#assistant-panel')?.hasAttribute('hidden')).toBe(true);
    // The same frame, so the conversation and unsent text survive.
    expect(page.querySelector('iframe')).toBe(frame);
  });

  function screenWidth(narrow: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: narrow,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }

  it('on a narrow screen, moves the keyboard into the panel, makes the page inert, and returns it on close', async () => {
    assistantUrl = url;
    assistantPanel = true;
    screenWidth(true);
    const page = await render();
    const toggle = page.querySelector<HTMLButtonElement>('button[aria-controls="assistant-panel"]');
    toggle?.focus();
    act(() => toggle?.click());
    const panel = page.querySelector<HTMLElement>('#assistant-panel');
    const frame = page.querySelector('iframe');
    expect(panel?.contains(document.activeElement)).toBe(true);
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(page.querySelector('.main')?.hasAttribute('inert')).toBe(true);
    expect(page.querySelector('.sidebar')?.hasAttribute('inert')).toBe(true);

    act(() => panel?.querySelector<HTMLButtonElement>('.assistant-panel-head button')?.click());
    expect(panel?.hasAttribute('hidden')).toBe(true);
    expect(page.querySelector('.main')?.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(toggle);

    // Escape from the panel's controls closes it too, and the frame is still the same one.
    act(() => toggle?.click());
    const close = panel?.querySelector<HTMLButtonElement>('.assistant-panel-head button');
    act(() => {
      close?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel?.hasAttribute('hidden')).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(page.querySelector('iframe')).toBe(frame);
  });

  it('on a wide screen, keeps the page usable beside the open panel', async () => {
    assistantUrl = url;
    assistantPanel = true;
    screenWidth(false);
    const page = await render();
    act(() =>
      page.querySelector<HTMLButtonElement>('button[aria-controls="assistant-panel"]')?.click(),
    );
    const panel = page.querySelector<HTMLElement>('#assistant-panel');
    expect(panel?.contains(document.activeElement)).toBe(true);
    expect(panel?.hasAttribute('aria-modal')).toBe(false);
    expect(page.querySelector('.main')?.hasAttribute('inert')).toBe(false);
  });

  it('shows no assistant at all without an address, even with the panel on', async () => {
    assistantPanel = true;
    const page = await render();
    expect(page.querySelector('button[aria-controls="assistant-panel"]')).toBeNull();
    expect(page.querySelector('iframe')).toBeNull();
  });
});
