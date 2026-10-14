import {
  ASSISTANT_DECIDABLE_KINDS,
  type DraftCapabilitiesDto,
  type Permission,
  type SettleDraftKind,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';

/**
 * Each draft kind the assistant creates: its routes, its review page and the permissions its
 * create route requires (draft-capabilities.spec.ts checks these against the controllers).
 */
export const DRAFT_KIND_ROUTES: Record<
  SettleDraftKind,
  { path: string; review: string; create: readonly Permission[]; preCheck: boolean }
> = {
  booking: {
    path: '/booking-drafts',
    review: '/drafts/bookings/:id',
    create: ['bookings:create'],
    preCheck: true,
  },
  new_customer_booking: {
    path: '/new-customer-booking-drafts',
    review: '/drafts/new-customer-bookings/:id',
    create: ['bookings:create', 'customers:create'],
    preCheck: true,
  },
  quotation: {
    path: '/quotation-drafts',
    review: '/drafts/quotations/:id',
    create: ['quotations:create'],
    preCheck: true,
  },
  new_customer_quotation: {
    path: '/new-customer-quotation-drafts',
    review: '/drafts/new-customer-quotations/:id',
    create: ['quotations:create', 'customers:create'],
    preCheck: true,
  },
  invoice: {
    path: '/invoice-drafts',
    review: '/drafts/invoices/:id',
    create: ['customer_invoices:create'],
    preCheck: true,
  },
  receipt: {
    path: '/receipt-drafts',
    review: '/drafts/receipts/:id',
    create: ['receipts:create'],
    preCheck: true,
  },
  trip: {
    path: '/trip-drafts',
    review: '/drafts/trips/:id',
    create: ['transport_trips:create'],
    preCheck: true,
  },
  goods_release: {
    path: '/release-drafts',
    review: '/drafts/releases/:id',
    create: ['warehouse:create'],
    preCheck: true,
  },
  shipment_status: {
    path: '/shipment-status-drafts',
    review: '/drafts/shipment-statuses/:id',
    create: ['shipments:view'],
    preCheck: true,
  },
  party: {
    path: '/party-drafts',
    review: '/drafts/parties/:id',
    create: ['customers:update'],
    preCheck: true,
  },
  customer: {
    path: '/customer-drafts',
    review: '/drafts/customers/:id',
    create: ['customers:create'],
    preCheck: true,
  },
  rate_card: {
    path: '/rate-card-drafts',
    review: '/drafts/rate-cards/:id',
    create: ['rates:create'],
    preCheck: true,
  },
  // Values from a document the assistant read, reviewed with the document on the shipment's page:
  // no pre-check.
  grn: {
    path: '/shipments/:shipmentId/grn-drafts',
    review: '/drafts/grn/:id',
    create: ['warehouse:create', 'documents:view'],
    preCheck: false,
  },
};

/** What this NOLON offers the assistant, with the kinds this user may create now. */
export function draftCapabilities(user: AuthUser): DraftCapabilitiesDto {
  const decidable: readonly string[] = ASSISTANT_DECIDABLE_KINDS;
  return {
    api: 1,
    features: { preCheck: true, myDrafts: true, settle: true, settleAck: true },
    kinds: (Object.keys(DRAFT_KIND_ROUTES) as SettleDraftKind[]).map((kind) => {
      const route = DRAFT_KIND_ROUTES[kind];
      return {
        kind,
        path: route.path,
        preCheck: route.preCheck,
        review: route.review,
        canCreate: route.create.every((p) => user.permissions.has(p)),
        approval: decidable.includes(kind) ? 'both' : 'screen',
      };
    }),
  };
}
