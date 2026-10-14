import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { MyDraftItemDto, MyDraftKind } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { InvoiceDraftsService } from '../billing/invoice-drafts.service.js';
import { ReceiptDraftsService } from '../billing/receipt-drafts.service.js';
import { BookingDraftsService } from '../bookings/booking-drafts.service.js';
import { NewCustomerBookingDraftsService } from '../bookings/new-customer-booking-drafts.service.js';
import { CustomerDraftsService } from '../customers/customer-drafts.service.js';
import { PartyDraftsService } from '../customers/party-drafts.service.js';
import { DraftsService, type MyDraftRow, type MyDraftsQuery } from '../drafts/drafts.service.js';
import { QuotationDraftsService } from '../quotations/quotation-drafts.service.js';
import { RateCardDraftsService } from '../rates/rate-card-drafts.service.js';
import { ShipmentStatusDraftsService } from '../shipments/shipment-status-drafts.service.js';
import { TripDraftsService } from '../transport/trip-drafts.service.js';
import { GoodsReleaseDraftsService } from '../warehouse/goods-release-drafts.service.js';

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
    private readonly invoices: InvoiceDraftsService,
    private readonly receipts: ReceiptDraftsService,
    private readonly trips: TripDraftsService,
    private readonly releases: GoodsReleaseDraftsService,
    private readonly statuses: ShipmentStatusDraftsService,
    private readonly parties: PartyDraftsService,
    private readonly customers: CustomerDraftsService,
    private readonly rates: RateCardDraftsService,
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
      invoice: this.invoices,
      receipt: this.receipts,
      trip: this.trips,
      goods_release: this.releases,
      shipment_status: this.statuses,
      party: this.parties,
      customer: this.customers,
      rate_card: this.rates,
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
}

/** Newest (largest) first. */
function byDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}
