// @vitest-environment jsdom
import type { AgentClientDto, ApiClientDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let permissions: string[] = [];
const key: ApiClientDto = {
  id: 'k1',
  name: 'WhatsApp desk',
  keyPrefix: 'nlk_abc',
  branchCodes: ['DXB'],
  isActive: true,
  createdByName: 'Admin',
  createdAt: '2026-10-01T00:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
};
const platform: AgentClientDto = {
  id: 'a1',
  name: 'Staff assistant platform',
  clientId: 'erp-agents',
  redirectUri: 'https://agent.test/callback',
  audience: 'erp-agents',
  tenant: 'nolon',
  isActive: true,
  createdByName: 'Admin',
  createdAt: '2026-10-01T00:00:00Z',
  revokedAt: null,
};

vi.mock('next-intl', () => ({ useTranslations: (ns: string) => (k: string) => `${ns}.${k}` }));
vi.mock('@/lib/api', () => ({ api: () => Promise.resolve({}) }));
vi.mock('@/lib/master-data', () => ({ useLocalName: () => (l: { nameEn: string }) => l.nameEn }));
vi.mock('./commercial/Notice', () => ({ Notice: () => null, useFailureText: () => () => 'x' }));
vi.mock('./transport/common', () => ({ useDateTime: () => (iso: string | null) => iso ?? '' }));
vi.mock('./finance/common', () => ({
  useRecord: (path: string) => ({
    record: path === '/api-clients' ? [key] : [platform],
    notice: null,
    status: null,
    setRecord: () => {},
  }),
}));
vi.mock('./StaffShell', () => ({
  useMe: () => ({ permissions, branches: [] }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { ApiAccess } = await import('./ApiAccess');

let host: HTMLElement | null = null;

function show(): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<ApiAccess />));
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
});

describe('API keys page', () => {
  it('shows the Customer Service API keys and the assistant sign-in as two sections', () => {
    permissions = ['users:view'];
    const page = show();
    expect(page.querySelectorAll('h1')).toHaveLength(1);
    const sections = [...page.querySelectorAll('section')];
    expect(sections.map((s) => s.querySelector('h2')?.textContent)).toEqual([
      'ApiKeys.title',
      'AgentClients.title',
    ]);
    const [keys, signIn] = sections;
    expect(keys?.getAttribute('aria-labelledby')).toBe('api-keys-title');
    expect(keys?.querySelector('p.muted')?.textContent).toBe('ApiKeys.hint');
    expect(keys?.textContent).toContain('WhatsApp desk');
    expect(keys?.textContent).not.toContain('Staff assistant platform');
    expect(signIn?.querySelector('p.muted')?.textContent).toBe('AgentClients.hint');
    expect(signIn?.textContent).toContain('Staff assistant platform');
    expect(signIn?.textContent).not.toContain('WhatsApp desk');
  });

  it('shows nothing of either to those without users:view', () => {
    permissions = [];
    const page = show();
    expect(page.querySelector('section')).toBeNull();
    expect(page.textContent).toBe('Common.noAccess');
  });
});
