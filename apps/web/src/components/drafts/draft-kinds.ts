import type { MyDraftKind, Permission } from '@nolon/shared';

/**
 * The entry types the assistant may propose drafts for, as the review pages show them. Each has
 * its own API path; the API decides who may see and decide each draft.
 */
export const DRAFT_KINDS = [
  { key: 'quotations', api: '/quotation-drafts', view: 'quotations:view', kind: 'quotation' },
  { key: 'bookings', api: '/booking-drafts', view: 'bookings:view', kind: 'booking' },
  { key: 'trips', api: '/trip-drafts', view: 'transport_trips:view', kind: 'trip' },
  { key: 'releases', api: '/release-drafts', view: 'warehouse:view', kind: 'goods_release' },
  {
    key: 'shipment-statuses',
    api: '/shipment-status-drafts',
    view: 'shipments:view',
    kind: 'shipment_status',
  },
  { key: 'invoices', api: '/invoice-drafts', view: 'customer_invoices:view', kind: 'invoice' },
  { key: 'receipts', api: '/receipt-drafts', view: 'receipts:view', kind: 'receipt' },
  { key: 'customers', api: '/customer-drafts', view: 'customers:view', kind: 'customer' },
  { key: 'parties', api: '/party-drafts', view: 'customers:view', kind: 'party' },
  { key: 'rate-cards', api: '/rate-card-drafts', view: 'rates:view', kind: 'rate_card' },
  {
    key: 'new-customer-bookings',
    api: '/new-customer-booking-drafts',
    view: 'bookings:view',
    kind: 'new_customer_booking',
  },
  {
    key: 'new-customer-quotations',
    api: '/new-customer-quotation-drafts',
    view: 'quotations:view',
    kind: 'new_customer_quotation',
  },
] as const satisfies readonly { key: string; api: string; view: Permission; kind: MyDraftKind }[];

/**
 * The kinds the reviewers' list ("everything waiting") filters by: every kind above, and GRN
 * drafts, which are reviewed on their shipment's page. The label key is `kind_<key>`.
 */
export const REVIEW_KINDS: readonly { key: string; view: Permission; kind: MyDraftKind }[] = [
  ...DRAFT_KINDS,
  { key: 'grn', view: 'warehouse:view', kind: 'grn' },
];

export type DraftKind = (typeof DRAFT_KINDS)[number]['key'];

export function draftKind(key: string): (typeof DRAFT_KINDS)[number] | undefined {
  return DRAFT_KINDS.find((k) => k.key === key);
}

/** Any permission that shows at least one kind (the menu link). */
export const DRAFT_VIEW_PERMISSIONS: readonly Permission[] = DRAFT_KINDS.map((k) => k.view);
