import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { WindowDeskBookingDto, WindowDeskFilter, WindowDeskTodo } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { lockOutletsInTx, outletLimited, windowScope } from '../auth/outlet-scope.js';
import { bookingItemDto } from '../bookings/bookings.service.js';
import { toDecimalString } from '../common/money.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { dropOffDto, dropOffSelect } from '../customer-service/drop-off.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/** The most bookings the desk lists at once (the oldest confirmed). */
const LIST_LIMIT = 200;

const deskSelect = {
  id: true,
  number: true,
  branchId: true,
  confirmedAt: true,
  originLocationId: true,
  destinationLocationId: true,
  mode: true,
  items: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true, phone: true } },
  shipper: { select: { name: true, phone: true } },
  consignee: { select: { name: true, phone: true, city: true } },
  dropOff: { select: { ...dropOffSelect, id: true, code: true, branchId: true } },
  shipment: {
    select: {
      id: true,
      invoices: {
        where: { kind: 'MAIN', status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: {
          number: true,
          status: true,
          currency: true,
          total: true,
          paidAmount: true,
          creditedAmount: true,
        },
      },
      movements: {
        where: { kind: 'RECEIPT', cancellation: null },
        take: 1,
        select: { id: true },
      },
    },
  },
} as const satisfies Prisma.BookingSelect;

type DeskRow = Prisma.BookingGetPayload<{ select: typeof deskSelect }>;

/** What the window's routes act on, once authorizeWindowInTx has checked it (plan 13 section 2a). */
export interface WindowContext {
  bookingId: string;
  shipmentId: string;
  customerId: string;
  branchId: string;
  warehouseId: string;
  partnerId: string;
}

/**
 * Plan 13 sections 2 and 2a: the window desk. An Outlet Staff user sees the CONFIRMED bookings
 * whose goods are handed over at a window their outlet runs, in the window's branch, as a
 * projection built for the window: the sender and receiver as written on the booking, the cargo
 * lines and what the customer owes; never the customer's file, other bookings, costs or margins.
 * Every route is 404 while WINDOW_DESK_ENABLED is off, and 403 for anyone not limited by outlet.
 */
@Injectable()
export class WindowDeskService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async expected(
    user: AuthUser,
    filter: WindowDeskFilter,
    search: string | undefined,
  ): Promise<WindowDeskBookingDto[]> {
    this.requireDesk(user);
    const received: Prisma.WarehouseMovementListRelationFilter = {
      some: { kind: 'RECEIPT', cancellation: null },
    };
    const term = search?.trim();
    const rows = await this.prisma.booking.findMany({
      where: {
        AND: [
          { status: 'CONFIRMED', branchId: { in: [...user.allowedBranchIds] } },
          windowScope(user),
          filter === 'expected' ? { shipment: { movements: { none: received.some } } } : {},
          filter === 'received' ? { shipment: { movements: received } } : {},
          term
            ? {
                OR: [
                  { number: { contains: term, mode: 'insensitive' } },
                  { shipper: { phone: { contains: term } } },
                  { consignee: { phone: { contains: term } } },
                  // The customer's phone only where it is the sender shown (no shipper): never a
                  // way to probe the customer's file (F207-7).
                  { shipperId: null, customer: { phone: { contains: term } } },
                ],
              }
            : {},
        ],
      },
      // Oldest first (plan 13 section 2): past the cap, the newest are the ones left out.
      orderBy: [{ confirmedAt: 'asc' }, { number: 'asc' }],
      take: LIST_LIMIT,
      select: deskSelect,
    });
    // The window's branch is the booking's (a column comparison Prisma's filter cannot express).
    return rows
      .filter((r) => r.dropOff !== null && r.dropOff.branchId === r.branchId)
      .map(toDeskDto)
      .sort((a, b) => Number(a.received) - Number(b.received));
  }

  async booking(user: AuthUser, bookingId: string): Promise<WindowDeskBookingDto> {
    this.requireDesk(user);
    return this.prisma.$transaction(async (tx) => {
      const ctx = await authorizeWindowInTx(tx, user, bookingId);
      const row = await tx.booking.findUniqueOrThrow({
        where: { id: ctx.bookingId },
        select: deskSelect,
      });
      return toDeskDto(row);
    });
  }

  private requireDesk(user: AuthUser): void {
    if (!this.env.WINDOW_DESK_ENABLED) throw new NotFoundException();
    if (!outletLimited(user))
      throw new ForbiddenException('The window desk is for partner outlets');
  }
}

/**
 * Plan 13 section 2a: the one check every window route runs first, inside its transaction. The
 * user's outlets as they are now (lockOutletsInTx: 403 when their access changed since sign-in),
 * then the booking `FOR SHARE` (CONFIRMED, with a window), then its window `FOR SHARE` (active,
 * taking shipments, run by one of the user's outlets, of the booking's branch, which is one of
 * the user's). Anything else is 404: the window learns nothing about bookings not its own.
 */
export async function authorizeWindowInTx(
  tx: Tx,
  user: AuthUser,
  bookingId: string,
): Promise<WindowContext> {
  const outlets = await lockOutletsInTx(tx, user);
  if (outlets === null) throw new ForbiddenException('The window desk is for partner outlets');
  const notFound = () => new NotFoundException('Booking not found');
  const bookings = await tx.$queryRaw<
    { status: string; branch_id: string; customer_id: string; window_id: string | null }[]
  >`SELECT "status"::text AS "status", "branch_id"::text AS "branch_id",
      "customer_id"::text AS "customer_id", "drop_off_warehouse_id"::text AS "window_id"
    FROM "bookings" WHERE "id" = ${bookingId}::uuid FOR SHARE`;
  const booking = bookings[0];
  if (!booking || booking.status !== 'CONFIRMED' || booking.window_id === null) throw notFound();
  const windows = await tx.$queryRaw<
    {
      branch_id: string;
      partner_id: string | null;
      is_active: boolean;
      accepts_drop_off: boolean;
    }[]
  >`SELECT "branch_id"::text AS "branch_id", "partner_id"::text AS "partner_id", "is_active",
      "accepts_drop_off"
    FROM "warehouses" WHERE "id" = ${booking.window_id}::uuid FOR SHARE`;
  const window = windows[0];
  if (
    !window?.is_active ||
    !window.accepts_drop_off ||
    window.partner_id === null ||
    !outlets.has(window.partner_id) ||
    window.branch_id !== booking.branch_id ||
    !user.allowedBranchIds.includes(booking.branch_id)
  )
    throw notFound();
  const shipments = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"::text AS "id" FROM "shipments" WHERE "booking_id" = ${bookingId}::uuid`;
  if (!shipments[0]) throw notFound();
  return {
    bookingId,
    shipmentId: shipments[0].id,
    customerId: booking.customer_id,
    branchId: booking.branch_id,
    warehouseId: booking.window_id,
    partnerId: window.partner_id,
  };
}

function toDeskDto(r: DeskRow): WindowDeskBookingDto {
  const point = r.dropOff && dropOffDto(r.dropOff);
  if (!r.dropOff || !point) throw new NotFoundException('Booking not found');
  const invoice = r.shipment?.invoices[0] ?? null;
  const received = (r.shipment?.movements.length ?? 0) > 0;
  // What is still owed, as every other balance reads it: total less paid less credited.
  const balance = invoice
    ? invoice.total.minus(invoice.paidAmount).minus(invoice.creditedAmount)
    : null;
  const todo: WindowDeskTodo[] = [];
  if (!received) todo.push('receive');
  if (invoice === null || balance!.gt(0)) todo.push('collect');
  const sender = r.shipper ?? r.customer;
  return {
    bookingId: r.id,
    bookingNumber: r.number,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    sender: { name: sender.name, phone: sender.phone },
    receiver: r.consignee
      ? { name: r.consignee.name, phone: r.consignee.phone, city: r.consignee.city }
      : null,
    originLocationId: r.originLocationId,
    destinationLocationId: r.destinationLocationId,
    mode: r.mode,
    items: r.items.map(bookingItemDto),
    window: { ...point, id: r.dropOff.id, code: r.dropOff.code },
    invoice:
      invoice && (invoice.status === 'DRAFT' || invoice.status === 'APPROVED')
        ? {
            number: invoice.number,
            status: invoice.status,
            currency: invoice.currency,
            total: toDecimalString(invoice.total),
            balance: toDecimalString(balance!),
          }
        : null,
    received,
    todo,
  };
}
