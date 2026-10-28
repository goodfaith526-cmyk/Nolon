// @vitest-environment jsdom
import type {
  CustomerDraftDto,
  EntryDraftReviewFields,
  GoodsReleaseDraftDto,
  InvoiceDraftDto,
  NewCustomerBookingDraftDto,
  NewCustomerQuotationDraftDto,
  PartyDraftDto,
  ReceiptDraftDto,
  ShipmentStatusDraftDto,
  TripDraftDto,
} from '@nolon/shared';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The review screens of drafts saved with missing values (no-required-fields plan, 3.2): each
// renders a draft holding none of its business values, a missing value shown as a dash and named
// by MissingFields, never as "null", "undefined" or zero.

const translate = Object.assign((key: string) => key, { has: () => false });
vi.mock('next-intl', () => ({ useTranslations: () => translate, useLocale: () => 'en' }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/api', () => ({ api: vi.fn(), ApiError: class extends Error {} }));
vi.mock('@/lib/master-data', () => ({
  isPlace: (l: { kind?: string }) => l.kind !== 'COUNTRY',
  useMasterData: () => null,
  useLocalName: () => (item: { nameEn: string }) => item.nameEn,
  useLocationName: () => (id: string) => `place:${id}`,
  failureStatus: () => 0,
}));
vi.mock('../StaffShell', () => ({ useMe: () => ({ permissions: [] }), can: () => false }));
vi.mock('../finance/reports/ReportKit', () => ({ useApiList: () => null }));
let current: unknown = null;
vi.mock('../finance/common', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRecord: () => ({ record: current, notice: null, status: 200, setRecord: () => undefined }),
}));

const { CustomerDraftReview } = await import('./CustomerDraftReview');
const { PartyDraftReview } = await import('./PartyDraftReview');
const { ShipmentStatusDraftReview } = await import('./ShipmentStatusDraftReview');
const { ReleaseDraftReview } = await import('./ReleaseDraftReview');
const { InvoiceDraftReview } = await import('./InvoiceDraftReview');
const { ReceiptDraftReview } = await import('./ReceiptDraftReview');
const { TripDraftReview } = await import('./TripDraftReview');
const { NewCustomerQuotationDraftReview } = await import('./NewCustomerQuotationDraftReview');
const { NewCustomerBookingDraftReview } = await import('./NewCustomerBookingDraftReview');

const BRANCH = '0b6f6c1e-5f0e-4a43-9a51-6c3c6b0f0a01';

const base: EntryDraftReviewFields = {
  id: 'd1',
  branchId: BRANCH,
  subject: '',
  status: 'DRAFT',
  version: 1,
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

function show(draft: unknown, view: ReactNode): HTMLElement {
  current = draft;
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(view));
  return host;
}

afterEach(() => {
  host?.remove();
  host = null;
  current = null;
});

function expectNullSafe(el: HTMLElement, missing: string[]) {
  const text = el.textContent ?? '';
  expect(text).toContain('—');
  expect(text).not.toMatch(/null|undefined|NaN/);
  const named = [...el.querySelectorAll('.missing-list li')].map((li) => li.textContent);
  expect(named).toEqual(missing);
}

describe('review screens: a draft holding none of its values', () => {
  it('customer', () => {
    const draft: CustomerDraftDto = {
      ...base,
      evidence: [],
      missingFields: ['kind', 'name', 'phone'],
      branchCode: 'DXB',
      request: { kind: null, name: null, phone: null },
      check: null,
      customerId: null,
      customerNumber: null,
      bookingDraftId: null,
    };
    expectNullSafe(show(draft, <CustomerDraftReview id="d1" />), ['kind', 'name', 'phone']);
  });

  it('party', () => {
    const draft: PartyDraftDto = {
      ...base,
      evidence: [],
      missingFields: ['customerId', 'name'],
      customerId: null,
      customerNumber: null,
      customerName: null,
      request: { name: null },
      check: null,
      partyId: null,
    };
    expectNullSafe(show(draft, <PartyDraftReview id="d1" />), ['customerId', 'name']);
  });

  it('shipment status', () => {
    const draft: ShipmentStatusDraftDto = {
      ...base,
      evidence: [],
      missingFields: ['shipmentId', 'status'],
      shipmentId: null,
      shipmentNumber: null,
      currentStatus: null,
      locationName: null,
      request: { status: null },
      check: null,
    };
    expectNullSafe(show(draft, <ShipmentStatusDraftReview id="d1" />), ['shipmentId', 'status']);
  });

  it('goods release', () => {
    const draft: GoodsReleaseDraftDto = {
      ...base,
      missingFields: ['shipmentId', 'warehouseId', 'packages'],
      shipmentId: null,
      shipmentNumber: null,
      warehouseCode: null,
      request: { warehouseId: null, packages: null },
      check: null,
      movementId: null,
      movementNumber: null,
    };
    expectNullSafe(show(draft, <ReleaseDraftReview id="d1" />), [
      'shipmentId',
      'warehouseId',
      'packages',
    ]);
  });

  it('invoice, a line missing its values too', () => {
    const draft: InvoiceDraftDto = {
      ...base,
      missingFields: ['shipmentId', 'currency', 'lines[0].quantity'],
      shipmentInvoices: [],
      customerId: null,
      customerName: null,
      shipmentNumber: null,
      request: {
        shipmentId: null,
        currency: null,
        invoiceDate: null,
        dueDate: null,
        notes: null,
        lines: [{ chargeTypeCode: null, description: null, quantity: null, unitPrice: null }],
      },
      priceSources: [],
      check: null,
      invoiceId: null,
      invoiceNumber: null,
    };
    const el = show(draft, <InvoiceDraftReview id="d1" />);
    expect(el.textContent).not.toMatch(/null|undefined|NaN/);
    expect(el.querySelectorAll('.missing-list li')).toHaveLength(3);
  });

  it('receipt, an allocation missing its invoice', () => {
    const draft: ReceiptDraftDto = {
      ...base,
      missingFields: ['customerId', 'amount', 'allocations[0].invoiceId'],
      customerId: null,
      customerName: null,
      request: {
        customerId: null,
        receiptDate: null,
        currency: null,
        amount: null,
        cashAccountId: null,
        reference: null,
        notes: null,
        allocations: [{ invoiceId: null, amount: null }],
      },
      cashAccountCode: null,
      cashAccountNameEn: null,
      cashAccountNameAr: null,
      invoiceNumbers: ['—'],
      check: null,
      receiptId: null,
      receiptNumber: null,
    };
    const el = show(draft, <ReceiptDraftReview id="d1" />);
    expect(el.textContent).not.toMatch(/null|undefined|NaN/);
    expect(el.querySelectorAll('.missing-list li')).toHaveLength(3);
  });

  it('trip with no kind', () => {
    const draft: TripDraftDto = {
      ...base,
      missingFields: ['kind', 'originLocationId', 'destinationLocationId'],
      request: {
        branchId: BRANCH,
        kind: null,
        originLocationId: null,
        destinationLocationId: null,
        shipmentIds: [],
      },
      shipmentNumbers: [],
      vehiclePlate: null,
      driverName: null,
      carrierName: null,
      check: null,
      tripId: null,
      tripNumber: null,
    };
    expectNullSafe(show(draft, <TripDraftReview id="d1" />), [
      'kind',
      'originLocationId',
      'destinationLocationId',
    ]);
  });

  it('quotation for a new customer: both parts', () => {
    const draft: NewCustomerQuotationDraftDto = {
      ...base,
      evidence: [],
      missingFields: ['customer.name', 'quotation.currency', 'quotation.lines'],
      branchCode: 'DXB',
      customer: { kind: null, name: null, phone: null },
      request: {
        originLocationId: null,
        destinationLocationId: null,
        mode: null,
        cargoType: null,
        currency: null,
        validUntil: null,
        lines: [],
      },
      check: null,
      pricing: null,
      priceSources: null,
      customerId: null,
      customerNumber: null,
      quotationId: null,
      quotationNumber: null,
    };
    const el = show(draft, <NewCustomerQuotationDraftReview id="d1" />);
    expectNullSafe(el, ['name', 'currency', 'lines']);
  });

  it("booking for a new customer: the booking's values here, the customer's on its draft", () => {
    const draft: NewCustomerBookingDraftDto = {
      ...base,
      evidence: [],
      missingFields: ['customer.phone', 'booking.mode', 'booking.services'],
      branchCode: 'DXB',
      request: {
        originLocationId: null,
        destinationLocationId: null,
        mode: null,
        cargoType: null,
        services: [],
        items: [{ cargoType: null, quantity: null }],
      },
      check: null,
      customer: {
        draftId: 'c1',
        status: 'DRAFT',
        name: null,
        phone: null,
        customerId: null,
        customerNumber: null,
      },
      container: null,
      bookingId: null,
      bookingNumber: null,
    };
    expectNullSafe(show(draft, <NewCustomerBookingDraftReview id="d1" />), ['mode', 'services']);
  });
});
