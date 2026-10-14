// @vitest-environment jsdom
import type { DraftContainer } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let permissions: string[] = [];
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as string}</a>
  ),
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { DraftContainerDetails } = await import('./DraftContainerDetails');

const container = {
  id: 'k1',
  number: 'NOL-CON-000001',
  containerTypeCode: '20GP',
  containerNumber: null,
  etd: null,
} as unknown as DraftContainer;

let host: HTMLElement | null = null;

function show(): HTMLElement {
  host = document.createElement('dl');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<DraftContainerDetails id="k1" container={container} />));
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
});

describe('DraftContainerDetails', () => {
  it('links the container number for those who may open the container page', () => {
    permissions = ['consolidation:view'];
    const link = show().querySelector('a');
    expect(link?.getAttribute('href')).toBe('/consolidations/k1');
    expect(link?.textContent).toBe('NOL-CON-000001');
  });

  it('shows the number as plain text to those who may only book into it (Sales)', () => {
    permissions = ['container_booking:create', 'bookings:create'];
    const shown = show();
    expect(shown.querySelector('a')).toBeNull();
    expect(shown.textContent).toContain('NOL-CON-000001');
  });
});
