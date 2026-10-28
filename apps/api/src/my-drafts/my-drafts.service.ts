import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  DraftActions,
  DraftKeySettlementDto,
  DraftStatus,
  EntryDraftReviewFields,
  MyDraftItemDto,
  MyDraftKind,
  Permission,
  ReviewDraftsPageDto,
  SettleDraftKind,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';
import { InvoiceDraftsService } from '../billing/invoice-drafts.service.js';
import { ReceiptDraftsService } from '../billing/receipt-drafts.service.js';
import { BookingDraftsService } from '../bookings/booking-drafts.service.js';
import { NewCustomerBookingDraftsService } from '../bookings/new-customer-booking-drafts.service.js';
import { CustomerDraftsService } from '../customers/customer-drafts.service.js';
import { PartyDraftsService } from '../customers/party-drafts.service.js';
import {
  type DraftTable,
  DraftsService,
  type MyDraftRow,
  type MyDraftsQuery,
  type ReviewDraftRow,
  type ReviewPage,
  reviewDraftItem,
  settleKeyInTx,
} from '../drafts/drafts.service.js';
import { NewCustomerQuotationDraftsService } from '../quotations/new-customer-quotation-drafts.service.js';
import { QuotationDraftsService } from '../quotations/quotation-drafts.service.js';
import { RateCardDraftsService } from '../rates/rate-card-drafts.service.js';
import { ShipmentStatusDraftsService } from '../shipments/shipment-status-drafts.service.js';
import { TripDraftsService } from '../transport/trip-drafts.service.js';
import { GoodsReleaseDraftsService } from '../warehouse/goods-release-drafts.service.js';
import { GrnDraftsService } from '../warehouse/grn-drafts.service.js';

/** The table each kind's drafts and keys live in. */
const SETTLE_TABLES: Record<SettleDraftKind, DraftTable> = {
  booking: 'booking_drafts',
  new_customer_booking: 'new_customer_booking_drafts',
  quotation: 'quotation_drafts',
  new_customer_quotation: 'new_customer_quotation_drafts',
  invoice: 'invoice_drafts',
  receipt: 'receipt_drafts',
  trip: 'trip_drafts',
  goods_release: 'goods_release_drafts',
  shipment_status: 'shipment_status_drafts',
  party: 'party_drafts',
  customer: 'customer_drafts',
  rate_card: 'rate_card_drafts',
  grn: 'grn_drafts',
};

/**
 * "My drafts": every kind of draft the assistant made for this user, newest first, through each
 * kind's own service (its view permission, branch scope and status), so a draft in a branch the
 * user lost, or of a kind they may no longer see, is not listed.
 */
@Injectable()
export class MyDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: DraftsService,
    private readonly bookings: BookingDraftsService,
    private readonly newCustomerBookings: NewCustomerBookingDraftsService,
    private readonly quotations: QuotationDraftsService,
    private readonly newCustomerQuotations: NewCustomerQuotationDraftsService,
    private readonly invoices: InvoiceDraftsService,
    private readonly receipts: ReceiptDraftsService,
    private readonly trips: TripDraftsService,
    private readonly releases: GoodsReleaseDraftsService,
    private readonly statuses: ShipmentStatusDraftsService,
    private readonly parties: PartyDraftsService,
    private readonly customers: CustomerDraftsService,
    private readonly rates: RateCardDraftsService,
    private readonly grns: GrnDraftsService,
  ) {}

  async list(
    user: AuthUser,
    filter: Omit<MyDraftsQuery, 'agentClientId'>,
    kind?: MyDraftKind,
  ): Promise<MyDraftItemDto[]> {
    // Through the assistant: only the drafts this assistant client made.
    const agentClientId = user.agent
      ? await this.drafts.agentClientOf(user, 'Not available to this assistant')
      : null;
    const query: MyDraftsQuery = { ...filter, agentClientId };
    const services: Record<
      MyDraftKind,
      { mine: (u: AuthUser, q: MyDraftsQuery) => Promise<MyDraftRow[]> }
    > = {
      booking: this.bookings,
      new_customer_booking: this.newCustomerBookings,
      quotation: this.quotations,
      new_customer_quotation: this.newCustomerQuotations,
      invoice: this.invoices,
      receipt: this.receipts,
      trip: this.trips,
      goods_release: this.releases,
      shipment_status: this.statuses,
      party: this.parties,
      customer: this.customers,
      rate_card: this.rates,
      grn: this.grns,
    };
    const kinds = kind ? [services[kind]] : Object.values(services);
    // Each kind returns at most `limit`; the newest `limit` of them all are the answer.
    const all = (await Promise.all(kinds.map((k) => k.mine(user, query)))).flat();
    const rows = all
      // The order of MY_DRAFTS_ORDER: ISO times and lower-case uuids compare as plain strings, as
      // PostgreSQL compares the timestamps and the uuids' bytes.
      .sort((a, b) => byDesc(a.createdAt, b.createdAt) || byDesc(a.id, b.id))
      .slice(0, query.limit);
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.branchId))] } },
      select: { id: true, code: true },
    });
    const codes = new Map(branches.map((b) => [b.id, b.code]));
    return rows.map((r) => ({ ...r, branchCode: codes.get(r.branchId) ?? '' }));
  }

  /**
   * The reviewers' list, "everything waiting" (GET /assistant-drafts/review): open drafts of every
   * kind (GRN drafts included), whoever they were made for, through each kind's own review list
   * (its view permission, branch scope and status), that this person may decide now (each kind's
   * `canDecide`), newest first, one page after the cursor. Not "my drafts" (mine): that list is the
   * user's own drafts. Customer drafts this reviewer approves with their booking for a new
   * customer are left out while that booking draft is open (CustomerDraftsService.listForReview).
   *
   * Paging: each kind reads at most `limit` drafts after the cursor; the newest `limit` of them all
   * make the page, and `next` is its last draft (drafts the reviewer may not decide are dropped
   * after the page is cut, so no draft is skipped).
   */
  async review(user: AuthUser, page: ReviewPage, kind?: MyDraftKind): Promise<ReviewDraftsPageDto> {
    if (user.agent) throw new ForbiddenException("The review list is a person's");
    const lists = this.reviewLists(user);
    const kinds = kind ? lists.filter(([k]) => k === kind) : lists;
    const perKind = await Promise.all(kinds.map(([, list]) => list(page)));
    const all = perKind
      .flat()
      .sort((a, b) => byDesc(a.createdAt, b.createdAt) || byDesc(a.id, b.id));
    const rows = all.slice(0, page.limit);
    const more = all.length > page.limit || perKind.some((k) => k.length >= page.limit);
    const last = rows.at(-1);
    const items = rows.filter((r) => r.canDecide);
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: [...new Set(items.map((r) => r.branchId))] } },
      select: { id: true, code: true },
    });
    const codes = new Map(branches.map((b) => [b.id, b.code]));
    return {
      items: items.map(({ canDecide: _decides, ...r }) => ({
        ...r,
        branchCode: codes.get(r.branchId) ?? '',
      })),
      next: more && last ? { before: last.createdAt, beforeId: last.id } : null,
    };
  }

  /** Each kind's reviewers' page, for the kinds this user may view. */
  private reviewLists(
    user: AuthUser,
  ): [MyDraftKind, (page: ReviewPage) => Promise<ReviewDraftRow[]>][] {
    const rows =
      <K extends Exclude<MyDraftKind, 'grn'>>(
        kind: K,
        list: (
          page: ReviewPage,
        ) => Promise<(EntryDraftReviewFields & { missingFields?: string[] })[]>,
      ) =>
      async (page: ReviewPage) =>
        (await list(page)).map((d) => reviewDraftItem(kind, d));
    const all: [Permission, MyDraftKind, (page: ReviewPage) => Promise<ReviewDraftRow[]>][] = [
      [
        'quotations:view',
        'quotation',
        rows('quotation', (p) => this.quotations.list(user, 'DRAFT', undefined, p)),
      ],
      [
        'quotations:view',
        'new_customer_quotation',
        rows('new_customer_quotation', (p) =>
          this.newCustomerQuotations.list(user, 'DRAFT', undefined, p),
        ),
      ],
      [
        'bookings:view',
        'booking',
        rows('booking', (p) => this.bookings.list(user, 'DRAFT', undefined, p)),
      ],
      [
        'bookings:view',
        'new_customer_booking',
        rows('new_customer_booking', (p) =>
          this.newCustomerBookings.list(user, 'DRAFT', undefined, p),
        ),
      ],
      [
        'transport_trips:view',
        'trip',
        rows('trip', (p) => this.trips.list(user, 'DRAFT', undefined, p)),
      ],
      [
        'warehouse:view',
        'goods_release',
        rows('goods_release', (p) => this.releases.list(user, 'DRAFT', undefined, p)),
      ],
      ['warehouse:view', 'grn', (p) => this.grns.reviewList(user, p)],
      [
        'shipments:view',
        'shipment_status',
        rows('shipment_status', (p) => this.statuses.list(user, 'DRAFT', undefined, p)),
      ],
      [
        'customer_invoices:view',
        'invoice',
        rows('invoice', (p) => this.invoices.list(user, 'DRAFT', undefined, p)),
      ],
      [
        'receipts:view',
        'receipt',
        rows('receipt', (p) => this.receipts.list(user, 'DRAFT', undefined, p)),
      ],
      [
        'customers:view',
        'customer',
        rows('customer', (p) => this.customers.listForReview(user, 'DRAFT', p)),
      ],
      [
        'customers:view',
        'party',
        rows('party', (p) => this.parties.list(user, 'DRAFT', undefined, p)),
      ],
      [
        'rates:view',
        'rate_card',
        rows('rate_card', (p) => this.rates.list(user, 'DRAFT', undefined, p)),
      ],
    ];
    return all
      .filter(([permission]) => visibleKind(user, permission))
      .map(([, kind, list]) => [kind, list]);
  }

  /**
   * Home page: the drafts waiting for a decision (status DRAFT) that this user may approve or
   * reject now, through each kind's own review list (its branch scope, and its `canDecide`), of
   * the kinds they may view; null when they may view none. The kinds of the review screens: a GRN
   * draft is reviewed on its shipment, not listed there. Each kind counts at most what its review
   * list shows (200).
   */
  async awaitingReview(user: AuthUser): Promise<number | null> {
    const lists: [
      Permission,
      (u: AuthUser, s: DraftStatus) => Promise<{ actions: DraftActions }[]>,
    ][] = [
      ['quotations:view', (u, s) => this.quotations.list(u, s)],
      ['quotations:view', (u, s) => this.newCustomerQuotations.list(u, s)],
      ['bookings:view', (u, s) => this.bookings.list(u, s)],
      ['bookings:view', (u, s) => this.newCustomerBookings.list(u, s)],
      ['transport_trips:view', (u, s) => this.trips.list(u, s)],
      ['warehouse:view', (u, s) => this.releases.list(u, s)],
      ['shipments:view', (u, s) => this.statuses.list(u, s)],
      ['customer_invoices:view', (u, s) => this.invoices.list(u, s)],
      ['receipts:view', (u, s) => this.receipts.list(u, s)],
      ['customers:view', (u, s) => this.customers.listForReview(u, s)],
      ['customers:view', (u, s) => this.parties.list(u, s)],
      ['rates:view', (u, s) => this.rates.list(u, s)],
    ];
    const visible = lists.filter(([permission]) => visibleKind(user, permission));
    if (visible.length === 0) return null;
    const counts = await Promise.all(
      visible.map(async ([, list]) =>
        (await list(user, 'DRAFT')).reduce((n, d) => (d.actions.canDecide ? n + 1 : n), 0),
      ),
    );
    return counts.reduce((a, b) => a + b, 0);
  }

  /**
   * Settles the key of a create the assistant got no answer for (settleKeyInTx); with `ack`, also
   * records that the assistant's task under it is final. Only through the assistant, for the key
   * its own client used for this user.
   */
  async settle(
    user: AuthUser,
    kind: SettleDraftKind,
    idempotencyKey: string,
    ack = false,
  ): Promise<DraftKeySettlementDto> {
    const agentClientId = await this.drafts.agentClientOf(user, 'Only the assistant settles a key');
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    return this.prisma.$transaction((tx) => settleKeyInTx(tx, SETTLE_TABLES[kind], scope, ack));
  }
}

/** Whether the user may view a kind's drafts now (its view permission). */
function visibleKind(user: AuthUser, permission: Permission): boolean {
  return (
    // In some branch: each kind's list keeps to the branches where it is held.
    user.access.any(permission) &&
    // A Driver neither sees nor decides trip drafts (TripDraftsService refuses them).
    !(permission === 'transport_trips:view' && limitedToOwnTrips(user, 'transport_trips'))
  );
}

/** Newest (largest) first. */
function byDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}
