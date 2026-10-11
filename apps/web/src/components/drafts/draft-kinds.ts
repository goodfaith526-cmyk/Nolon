import type { Permission } from '@nolon/shared';

/**
 * The entry types the assistant may propose drafts for, as the review pages show them. Each has
 * its own API path; the API decides who may see and decide each draft.
 */
export const DRAFT_KINDS = [
  { key: 'quotations', api: '/quotation-drafts', view: 'quotations:view' },
  { key: 'bookings', api: '/booking-drafts', view: 'bookings:view' },
  { key: 'trips', api: '/trip-drafts', view: 'transport_trips:view' },
  { key: 'releases', api: '/release-drafts', view: 'warehouse:view' },
  { key: 'invoices', api: '/invoice-drafts', view: 'customer_invoices:view' },
  { key: 'receipts', api: '/receipt-drafts', view: 'receipts:view' },
] as const satisfies readonly { key: string; api: string; view: Permission }[];

export type DraftKind = (typeof DRAFT_KINDS)[number]['key'];

export function draftKind(key: string): (typeof DRAFT_KINDS)[number] | undefined {
  return DRAFT_KINDS.find((k) => k.key === key);
}

/** Any permission that shows at least one kind (the menu link). */
export const DRAFT_VIEW_PERMISSIONS: readonly Permission[] = DRAFT_KINDS.map((k) => k.view);
