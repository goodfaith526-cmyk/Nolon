// @vitest-environment jsdom
import type {
  CustomerDraftDto,
  EntryDraftReviewFields,
  GoodsReleaseDraftDto,
  InvoiceDraftDto,
  NewCustomerBookingDraftDto,
  ReceiptDraftDto,
  ReviewDraftsPageDto,
} from '@nolon/shared';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The review screens' reads of functional review هـ (the reviewers' list, one-step approval of a
// booking with its new customer, NOLON's suggestions and pick lists): what the API answers is
// shown and sent back as it is; the screens decide nothing.

const translate = Object.assign(
  (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join(',')})` : key,
  { has: () => false },
);
vi.mock('next-intl', () => ({ useTranslations: () => translate, useLocale: () => 'en' }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const api = vi.fn<(path: string, init?: { method: string; body: unknown }) => Promise<unknown>>();
vi.mock('@/lib/api', () => ({ api, ApiError: class extends Error {} }));
vi.mock('@/lib/master-data', () => ({
  isPlace: (l: { kind?: string }) => l.kind !== 'COUNTRY',
  useMasterData: () => null,
  useLocalName: () => (item: { nameEn: string }) => item.nameEn,
  useLocationName: () => (id: string) => `place:${id}`,
  failureStatus: () => 0,
}));
vi.mock('../StaffShell', () => ({ useMe: () => ({ permissions: [] }), can: () => true }));
vi.mock('../finance/reports/ReportKit', () => ({ useApiList: () => null }));
let current: unknown = null;
vi.mock('../finance/common', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRecord: () => ({ record: current, notice: null, status: 200, setRecord: () => undefined }),
}));

const { AssistantDrafts } = await import('./AssistantDrafts');
const { NewCustomerBookingDraftReview } = await import('./NewCustomerBookingDraftReview');
const { ReleaseDraftReview } = await import('./ReleaseDraftReview');
const { ReceiptDraftReview } = await import('./ReceiptDraftReview');
const { InvoiceDraftReview } = await import('./InvoiceDraftReview');

const base: EntryDraftReviewFields = {
  id: 'd1',
  branchId: 'b1',
  subject: '',
  status: 'DRAFT',
  version: 2,
  expiresAt: '2026-10-20T00:00:00.000Z',
  createdAt: '2026-10-18T00:00:00.000Z',
  createdByName: 'Staff',
  decidedByName: null,
  decidedAt: null,
  decidedFromAssistant: false,
  rejectReason: null,
  actions: { canEdit: true, canDecide: true },
  replacesDraftId: null,
};

let host: HTMLElement | null = null;

async function show(draft: unknown, view: ReactNode): Promise<HTMLElement> {
  current = draft;
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(view);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function answer(byPath: Record<string, unknown>) {
  api.mockImplementation((path: string) => {
    const key = Object.keys(byPath).find((p) => path === p || path.startsWith(`${p}?`));
    return key === undefined
      ? Promise.reject(new Error(`unexpected ${path}`))
      : Promise.resolve(byPath[key]);
  });
}

afterEach(() => {
  host?.remove();
  host = null;
  current = null;
  api.mockReset();
});

describe("the reviewers' list", () => {
  const page: ReviewDraftsPageDto = {
    items: [
      {
        kind: 'grn',
        id: 'g1',
        subject: 'SH-1',
        branchId: 'b1',
        branchCode: 'DXB',
        createdAt: '2026-10-18T00:00:00.000Z',
        expiresAt: '2026-10-20T00:00:00.000Z',
        createdByName: 'Staff',
        missingCount: null,
        reviewPath: '/shipments/s1',
      },
      {
        kind: 'invoice',
        id: 'i1',
        subject: 'SH-2',
        branchId: 'b1',
        branchCode: 'DXB',
        createdAt: '2026-10-17T00:00:00.000Z',
        expiresAt: '2026-10-20T00:00:00.000Z',
        createdByName: 'Staff',
        missingCount: 3,
        reviewPath: '/drafts/invoices/i1',
      },
    ],
    next: { before: '2026-10-17T00:00:00.000Z', beforeId: 'i1' },
  };

  it('opens on everything waiting, with what each draft misses, and pages on', async () => {
    answer({ '/assistant-drafts/review': page });
    const el = await show(null, <AssistantDrafts />);
    expect(api).toHaveBeenCalledWith('/assistant-drafts/review');
    const rows = [...el.querySelectorAll('tbody tr')].map((tr) => tr.textContent);
    expect(rows[0]).toContain('kind_grn');
    expect(rows[0]).toContain('—');
    expect(rows[1]).toContain('missingCount(3)');
    expect(el.querySelector('a[href="/shipments/s1"]')).not.toBeNull();
    const more = [...el.querySelectorAll('button')].find((b) => b.textContent === 'loadMore');
    answer({ '/assistant-drafts/review': { items: [], next: null } });
    await act(async () => {
      more?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api).toHaveBeenLastCalledWith(
      '/assistant-drafts/review?before=2026-10-17T00%3A00%3A00.000Z&beforeId=i1',
    );
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('filters by kind through the API', async () => {
    answer({ '/assistant-drafts/review': page });
    const el = await show(null, <AssistantDrafts />);
    const select = el.querySelector('select');
    if (!select) throw new Error('no filter');
    await act(async () => {
      const proto = Object.getPrototypeOf(select) as object;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(select, 'grn');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api).toHaveBeenLastCalledWith('/assistant-drafts/review?kind=grn');
  });
});

describe('a booking for a new customer, approved with its customer', () => {
  const booking: NewCustomerBookingDraftDto = {
    ...base,
    evidence: [],
    missingFields: [],
    branchCode: 'DXB',
    request: {
      originLocationId: 'o',
      destinationLocationId: 'd',
      mode: 'SEA',
      cargoType: 'GENERAL',
      services: [],
      items: [],
    },
    check: { ok: true, total: null, currency: null },
    customer: {
      draftId: 'c1',
      status: 'DRAFT',
      name: 'Amna',
      phone: '+249900000000',
      customerId: null,
      customerNumber: null,
    },
    container: null,
    bookingId: null,
    bookingNumber: null,
  };
  const customerDraft = (canDecide: boolean): CustomerDraftDto => ({
    ...base,
    version: 5,
    actions: { canEdit: canDecide, canDecide },
    evidence: [{ field: 'name', quote: 'آمنة' }],
    missingFields: [],
    branchCode: 'DXB',
    request: { kind: 'INDIVIDUAL', name: 'Amna', phone: '+249900000000' },
    check: null,
    customerId: null,
    customerNumber: null,
    bookingDraftId: 'd1',
  });
  const approveButton = (el: HTMLElement) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent === 'approve');

  it("sends the customer draft's version and words with the approval", async () => {
    answer({ '/customer-drafts/c1': customerDraft(true) });
    const el = await show(booking, <NewCustomerBookingDraftReview id="d1" />);
    expect(el.textContent).toContain('approveWithCustomer');
    expect(approveButton(el)?.disabled).toBe(true);
    const tick = el.querySelector<HTMLInputElement>('[id$="-evidence-name"]');
    act(() => tick?.click());
    expect(approveButton(el)?.disabled).toBe(false);
    api.mockResolvedValue({ ...booking, status: 'APPROVED' });
    await act(async () => {
      approveButton(el)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api).toHaveBeenLastCalledWith('/new-customer-booking-drafts/d1/approve', {
      method: 'POST',
      body: { confirmed: [], customer: { version: 5, confirmed: ['name'] }, version: 2 },
    });
  });

  it('shows every customer value the approval creates (Codex F97-1)', async () => {
    const full = customerDraft(true);
    answer({
      '/customer-drafts/c1': {
        ...full,
        request: {
          ...full.request,
          companyName: 'Amna Trading',
          email: 'amna@example.com',
          city: 'Khartoum',
          address: 'Street 15',
          notes: 'Pays in SDG',
        },
      },
    });
    const el = await show(booking, <NewCustomerBookingDraftReview id="d1" />);
    for (const value of [
      'Amna Trading',
      'amna@example.com',
      'Khartoum',
      'Street 15',
      'Pays in SDG',
    ]) {
      expect(el.textContent).toContain(value);
    }
  });

  it('keeps the two-step path for who may not decide the customer draft', async () => {
    answer({ '/customer-drafts/c1': customerDraft(false) });
    const el = await show(booking, <NewCustomerBookingDraftReview id="d1" />);
    expect(el.textContent).toContain('approveCustomerFirst');
    expect(approveButton(el)?.disabled).toBe(true);
  });
});

describe("NOLON's suggestions on the review screens", () => {
  it('a release opens with the one warehouse holding the goods and what it holds', async () => {
    const draft: GoodsReleaseDraftDto = {
      ...base,
      missingFields: ['warehouseId', 'packages'],
      shipmentId: 's1',
      shipmentNumber: 'SH-1',
      warehouseCode: null,
      request: { warehouseId: null, packages: null },
      check: null,
      movementId: null,
      movementNumber: null,
    };
    answer({
      '/release-drafts/d1/warehouse-options': {
        version: 2,
        options: [
          {
            warehouseId: 'w1',
            code: 'W1',
            nameEn: 'Store',
            nameAr: 'مخزن',
            branchId: 'b1',
            onHandPackages: 4,
            remainingWeightKg: null,
          },
        ],
        suggested: { warehouseId: 'w1', packages: 4 },
      },
    });
    const el = await show(draft, <ReleaseDraftReview id="d1" />);
    expect(el.querySelector('select')?.value).toBe('w1');
    expect([...el.querySelectorAll('option')].map((o) => o.textContent)).toContain(
      'heldIn(W1 · Store,4)',
    );
    expect(el.querySelector<HTMLInputElement>('.missing-value input')?.value).toBe('4');
  });

  it('an invoice opens with the currency and dates NOLON suggests for its version only', async () => {
    const draft: InvoiceDraftDto = {
      ...base,
      missingFields: ['currency', 'invoiceDate', 'dueDate'],
      shipmentInvoices: [],
      customerId: 'c1',
      customerName: 'Customer',
      shipmentNumber: 'SH-1',
      request: {
        shipmentId: 's1',
        currency: null,
        invoiceDate: null,
        dueDate: null,
        notes: null,
        lines: [],
      },
      priceSources: [],
      check: null,
      invoiceId: null,
      invoiceNumber: null,
    };
    answer({
      '/invoice-drafts/d1/suggested-values': {
        version: 2,
        values: { currency: 'USD', invoiceDate: '2026-10-19', dueDate: '2026-11-18' },
        currencySource: 'CUSTOMER',
      },
    });
    const el = await show(draft, <InvoiceDraftReview id="d1" />);
    const dates = [...el.querySelectorAll<HTMLInputElement>('input[type="date"]')].map(
      (i) => i.value,
    );
    expect(dates).toEqual(['2026-10-19', '2026-11-18']);
    host?.remove();
    // Worked out for another version: not offered.
    answer({
      '/invoice-drafts/d1/suggested-values': {
        version: 1,
        values: { currency: 'USD', invoiceDate: '2026-10-19', dueDate: '2026-11-18' },
        currencySource: 'CUSTOMER',
      },
    });
    const stale = await show(draft, <InvoiceDraftReview id="d1" />);
    await flush();
    expect(
      [...stale.querySelectorAll<HTMLInputElement>('input[type="date"]')].map((i) => i.value),
    ).toEqual(['', '']);
  });

  it("a receipt's cash accounts and invoices come from NOLON's pick lists", async () => {
    const draft: ReceiptDraftDto = {
      ...base,
      missingFields: ['cashAccountId', 'allocations[0].invoiceId'],
      customerId: 'c1',
      customerName: 'Customer',
      request: {
        customerId: 'c1',
        receiptDate: '2026-10-19',
        currency: 'USD',
        amount: '10',
        cashAccountId: null,
        reference: null,
        notes: null,
        allocations: [{ invoiceId: null, amount: '10' }],
      },
      cashAccountCode: null,
      cashAccountNameEn: null,
      cashAccountNameAr: null,
      invoiceNumbers: ['—'],
      check: null,
      receiptId: null,
      receiptNumber: null,
    };
    answer({
      '/receipt-drafts/cash-accounts': {
        items: [
          {
            id: 'a1',
            code: '1010',
            nameEn: 'Cash',
            nameAr: 'نقدية',
            currency: 'USD',
            isActive: true,
          },
        ],
      },
      '/receipt-drafts/open-invoices': {
        items: [
          {
            id: 'i1',
            number: 'INV-1',
            currency: 'USD',
            total: '50',
            outstanding: '20',
            invoiceDate: '2026-10-01',
            dueDate: '2026-10-31',
          },
        ],
      },
    });
    const el = await show(draft, <ReceiptDraftReview id="d1" />);
    expect(api).toHaveBeenCalledWith('/receipt-drafts/cash-accounts?customerId=c1&currency=USD');
    expect(api).toHaveBeenCalledWith('/receipt-drafts/open-invoices?customerId=c1&currency=USD');
    const options = [...el.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toContain('1010 · Cash · USD');
    expect(options).toContain('openInvoiceChoice(INV-1,20,USD)');
  });
});
