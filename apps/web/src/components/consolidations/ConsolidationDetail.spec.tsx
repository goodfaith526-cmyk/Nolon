// @vitest-environment jsdom
import type { ConsolidationDto } from '@nolon/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
const JEDDAH = { id: 'b2', code: 'JED', nameEn: 'Jeddah', today: '2026-10-28' };

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  api: (...args: unknown[]) => api(...args) as unknown,
}));
vi.mock('@/lib/master-data', async (actual) => ({
  ...(await actual<typeof import('@/lib/master-data')>()),
  useMasterData: () => ({ branches: [JEDDAH], containerTypes: [] }),
  useLocationName: () => (id: string) => id,
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ({ permissions: ['*'], allBranches: false, branches: [JEDDAH] }),
  can: () => true,
}));
vi.mock('../commercial/Notice', async (actual) => ({
  ...(await actual<typeof import('../commercial/Notice')>()),
  useFailureText: () => () => 'failed',
}));

const { ConsolidationDetail } = await import('./ConsolidationDetail');

const closed = (canReopen: boolean): ConsolidationDto =>
  ({
    id: 'c1',
    number: 'JED-PTS-C0001',
    branchId: 'b2',
    status: 'CLOSED',
    originLocationId: 'l1',
    destinationLocationId: 'l2',
    containerTypeCode: '40HC',
    containerNumber: 'ZQRU1234565',
    basis: 'CBM',
    closedAt: '2026-10-28T08:00:00.000Z',
    createdByName: 'Ops',
    shipments: [],
    costs: [],
    showsCost: false,
    ownBranch: true,
    capacity: {
      volumeCbm: { limit: null, used: '0', remaining: null, fillPercent: null, complete: true },
      weightKg: { limit: null, used: '0', remaining: null, fillPercent: null, complete: true },
      incomplete: [],
      asOfNow: true,
    },
    reopenRevision: 1,
    reopenings: [],
    actions: {
      canEdit: false,
      canAddShipments: false,
      canEditShipments: false,
      canAddBooking: false,
      moves: [],
      canCancel: false,
      canReopen,
    },
  }) as unknown as ConsolidationDto;

let root: Root | null = null;
let host: HTMLDivElement;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render(record: ConsolidationDto) {
  api.mockImplementation((path: string, init?: object) =>
    path === '/consolidations/c1' && !init
      ? Promise.resolve(record)
      : Promise.reject(new Error('refused')),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<ConsolidationDetail id="c1" />));
  await flush();
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  api.mockReset();
});

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;

describe('ConsolidationDetail: reopening (B3-5)', () => {
  it('offers the reopening only when the API allows it', async () => {
    await render(closed(false));
    expect(button('reopen')).toBeNull();
    act(() => root?.unmount());
    host.remove();
    await render(closed(true));
    expect(button('reopen')).not.toBeNull();
  });

  it('sends the revision it was opened on and one request id per attempt', async () => {
    await render(closed(true));
    act(() => button('reopen')?.click());
    const reason = host.querySelector<HTMLTextAreaElement>('textarea[name="reason"]');
    if (!reason) throw new Error('No reason');
    reason.value = 'Closed by mistake';
    const submit = async () => {
      act(() => reason.form?.requestSubmit());
      await flush();
    };
    await submit();
    await submit();
    const sent = api.mock.calls
      .filter(([path]) => path === '/consolidations/c1/reopen')
      .map(([, init]) => (init as { body: { requestId: string } }).body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      expectedRevision: 1,
      expectedStatus: 'CLOSED',
      reason: 'Closed by mistake',
    });
    // A retry of the same attempt keeps its request id.
    expect(sent[1]?.requestId).toBe(sent[0]?.requestId);
  });
});
