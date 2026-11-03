// @vitest-environment jsdom
import type { ApiClientDto, CsWebhooksDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let permissions: string[] = [];
const calls: { path: string; method?: string }[] = [];
const key: ApiClientDto = {
  id: 'k1',
  name: 'WhatsApp desk',
  keyPrefix: 'nolcs_abc',
  branchCodes: ['DXB'],
  scopes: ['cs:booking_requests:create'],
  services: [],
  isActive: true,
  createdByName: 'Admin',
  createdAt: '2026-10-01T00:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
};
const endpoint = (id: string, status: 'PENDING' | 'APPROVED', canApprove: boolean) => ({
  id,
  url: `https://agent.example.com/${id}`,
  audience: 'erp-agents:nolon',
  status,
  createdByName: 'Admin',
  createdAt: '2026-11-03T00:00:00Z',
  approvedByName: status === 'APPROVED' ? 'Other' : null,
  approvedAt: null,
  retiredAt: null,
  canApprove,
});
let view: CsWebhooksDto;

vi.mock('next-intl', () => ({ useTranslations: (ns: string) => (k: string) => `${ns}.${k}` }));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string }) => {
    calls.push({ path, method: init?.method });
    return Promise.resolve(view);
  },
}));
vi.mock('./commercial/Notice', () => ({ Notice: () => null, useFailureText: () => () => 'x' }));
vi.mock('./transport/common', () => ({ useDateTime: () => (iso: string | null) => iso ?? '' }));
vi.mock('./finance/common', () => ({
  useRecord: () => ({ record: view, notice: null, status: null, setRecord: () => {} }),
}));
vi.mock('./StaffShell', () => ({
  useMe: () => ({ permissions, branches: [] }),
  can: (me: { permissions: string[] }, p: string) => me.permissions.includes(p),
}));
const { ApiKeyWebhooks } = await import('./ApiKeyWebhooks');

let host: HTMLElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  calls.length = 0;
});

function show(): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<ApiKeyWebhooks client={key} onClose={() => undefined} />));
  return host;
}

const buttons = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].filter((b) => b.textContent === `ApiKeys.${label}`);

describe('ApiKeyWebhooks', () => {
  it('offers approval only where the API allows it, and sends it', async () => {
    permissions = ['users:view', 'users:create', 'users:update'];
    view = {
      secretConfigured: true,
      workerEnabled: true,
      allowedHosts: ['agent.example.com'],
      endpoints: [endpoint('e2', 'PENDING', true), endpoint('e1', 'APPROVED', false)],
      counts: { PENDING: 1, SENDING: 0, SENT: 3, FAILED: 1, CANCELLED_BY_POLICY: 0 },
      recent: [],
    };
    const el = show();
    expect(el.textContent).toContain('https://agent.example.com/e2');
    expect(el.textContent).toContain('ApiKeys.outbox_FAILED: 1');
    const approve = buttons(el, 'webhookApprove');
    expect(approve).toHaveLength(1);
    await act(async () => {
      approve[0]!.click();
      await Promise.resolve();
    });
    expect(calls).toEqual([{ path: '/api-clients/k1/webhooks/e2/approve', method: 'POST' }]);
  });

  it('holds approval without the secret and shows nothing to change without permission', () => {
    permissions = ['users:view', 'users:update'];
    view = {
      secretConfigured: false,
      workerEnabled: false,
      allowedHosts: [],
      endpoints: [endpoint('e2', 'PENDING', true)],
      counts: { PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0, CANCELLED_BY_POLICY: 0 },
      recent: [],
    };
    const el = show();
    expect(el.textContent).toContain('ApiKeys.webhookNoSecret');
    expect(buttons(el, 'webhookApprove')[0]!.disabled).toBe(true);
    // No users:create: no form to add an address.
    expect(el.querySelector('input[name="url"]')).toBeNull();
    host?.remove();
    permissions = ['users:view'];
    const viewer = show();
    expect(buttons(viewer, 'webhookApprove')).toHaveLength(0);
    expect(buttons(viewer, 'webhookRetire')).toHaveLength(0);
  });
});
