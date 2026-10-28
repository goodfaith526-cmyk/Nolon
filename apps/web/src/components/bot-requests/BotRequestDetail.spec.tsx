// @vitest-environment jsdom
import type { CsBookingRequestStaffDto } from '@nolon/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; init?: { method?: string; body?: unknown } }[] = [];
let shownRecord: CsBookingRequestStaffDto;
const base: CsBookingRequestStaffDto = {
  id: 'r1',
  reference: 'BR-000007',
  status: 'awaiting_routing',
  createdAt: '2026-10-28T00:00:00.000Z',
  expiresAt: '2026-11-11T00:00:00.000Z',
  branchId: null,
  originId: null,
  destinationId: 'krt',
  category: null,
  quantity: '2',
  senderName: 'Mohamed',
  channel: 'whatsapp',
  customerId: null,
  byNames: true,
  version: 3,
  allowedBranchIds: ['b-pts', 'b-jed'],
  customerNumber: null,
  contactPhone: '966500000000',
  consigneeName: 'Ahmed',
  consigneePhone: '0912345678',
  handover: 'PICKUP',
  services: [],
  requestedDate: null,
  language: null,
  botNames: {
    origin: { ar: 'جدة', en: 'Jeddah' },
    destination: { ar: 'الخرطوم', en: 'Khartoum' },
    kind: { ar: 'برميل', en: 'Barrel' },
  },
  botQuotedPrice: { amount: '550', currency: 'SAR' },
  quoteRef: null,
  priceCheck: null,
  routedAt: null,
  decidedAt: null,
  rejectReasonCode: null,
  internalNote: null,
  bookingId: null,
  bookingNumber: null,
  paymentCurrency: null,
  actions: { canRoute: true, canReject: true, canApprove: false },
};

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/master-data', () => ({
  useMasterData: () => null,
  useLocalName: () => (l: { nameEn: string }) => l.nameEn,
  useLocationName: () => (id: string) => `place:${id}`,
}));
vi.mock('@/lib/api', () => ({
  api: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    if (path.endsWith('reject-reasons')) {
      return Promise.resolve([
        { code: 'DUPLICATE', textAr: 'مكرر', textEn: 'Duplicate', isActive: true },
        { code: 'OLD', textAr: 'قديم', textEn: 'Old', isActive: false },
      ]);
    }
    return Promise.resolve(shownRecord);
  },
}));
vi.mock('../finance/common', () => ({
  useRecord: () => ({ record: shownRecord, notice: null, status: null, setRecord: () => {} }),
}));
vi.mock('../commercial/Notice', () => ({ Notice: () => null, useFailureText: () => () => 'x' }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../StaffShell', () => ({
  useMe: () => ({
    branches: [{ id: 'b-pts', code: 'PTS', nameEn: 'Port Sudan', nameAr: 'بورتسودان' }],
  }),
}));
const { BotRequestDetail } = await import('./BotRequestDetail');

let host: HTMLElement | null = null;

async function show(record: CsBookingRequestStaffDto): Promise<HTMLElement> {
  shownRecord = record;
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<BotRequestDetail id={record.id} />));
  await act(() => Promise.resolve());
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
  calls.length = 0;
});

describe('BotRequestDetail', () => {
  it('shows the bot’s words where nothing matched, and its price as a claim', async () => {
    const shown = await show(base);
    expect(shown.textContent).toContain('unmatched: «Jeddah»');
    expect(shown.textContent).toContain('place:krt');
    expect(shown.textContent).toContain('550 SAR');
    expect(shown.textContent).toContain('botPriceHint');
    expect(shown.textContent).toContain('noQuote');
  });

  it('routes only to the request’s branches the person has, with its version', async () => {
    const shown = await show(base);
    const select = shown.querySelector<HTMLSelectElement>('select[name="branchId"]')!;
    const options = [...select.options].map((o) => o.value).filter(Boolean);
    expect(options).toEqual(['b-pts']);
    act(() => {
      select.value = 'b-pts';
    });
    await act(async () => {
      select.form!.requestSubmit();
      await Promise.resolve();
    });
    expect(calls.find((c) => c.init?.method === 'POST')).toEqual({
      path: '/cs-booking-requests/r1/route',
      init: { method: 'POST', body: { version: 3, branchId: 'b-pts' } },
    });
    // Only active reasons are offered.
    const reasons = shown.querySelector<HTMLSelectElement>('select[name="reasonCode"]')!;
    expect([...reasons.options].map((o) => o.value).filter(Boolean)).toEqual(['DUPLICATE']);
  });

  it('links the booking an approval made', async () => {
    const shown = await show({
      ...base,
      status: 'approved',
      branchId: 'b-pts',
      bookingId: 'bk1',
      bookingNumber: 'BK-000042',
      paymentCurrency: 'SDG',
      actions: { canRoute: false, canReject: false, canApprove: false },
    });
    const link = shown.querySelector<HTMLAnchorElement>('a[href="/bookings/bk1"]');
    expect(link?.textContent).toBe('BK-000042');
    expect(shown.textContent).toContain('SDG');
  });

  it('offers no action the API does not allow', async () => {
    const shown = await show({
      ...base,
      actions: { canRoute: false, canReject: false, canApprove: false },
    });
    expect(shown.querySelector('form')).toBeNull();
  });
});
