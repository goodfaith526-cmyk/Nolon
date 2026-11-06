import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WindowDeskBookingDto, WindowDeskPaymentRequest } from '@nolon/shared';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CreditLimitService } from '../billing/credit-limit.service.js';
import { InvoicesService } from '../billing/invoices.service.js';
import { ReceiptsService, lockInvoices } from '../billing/receipts.service.js';
import { todayIn } from '../common/dates.js';
import { ZERO, dec, roundMoney } from '../common/money.js';
import { codedRefusal } from '../common/validation.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { WindowDeskService, authorizeWindowInTx } from './window-desk.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Plan 13 section 4: the window takes the customer's money. In one transaction, in the lock order
 * of closing and cancelling (the shipment first): the window's check, the window's cash account
 * for the currency, the approval of the booking's pro forma MAIN invoice when it is still one
 * (owner, 2026-11-05: the payment approves it), then a normal receipt (ReceiptsService.createInTx)
 * into that cash account, paying the booking's invoices in the currency, MAIN first, then
 * additional by date and number, each up to its balance, and the customer's credit check last.
 * The server allocates all of the amount: never more than is owed, never an advance.
 */
@Injectable()
export class WindowCollectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly desk: WindowDeskService,
    private readonly shipments: ShipmentsService,
    private readonly invoices: InvoicesService,
    private readonly receipts: ReceiptsService,
    private readonly credit: CreditLimitService,
    private readonly currencies: CurrenciesService,
    private readonly fxRates: FxRatesService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async collect(
    user: AuthUser,
    bookingId: string,
    input: WindowDeskPaymentRequest,
  ): Promise<WindowDeskBookingDto> {
    this.desk.requireDesk(user);
    if (!this.env.WINDOW_COLLECT_ENABLED) throw new NotFoundException();
    const done = await this.findForRetry(input.requestId);
    if (done) return this.retry(user, bookingId, done, input);
    try {
      await this.collectOnce(user, bookingId, input);
    } catch (error) {
      // A request racing one with its id fails once that one commits (on the receipt's id, or on
      // the balance it used): it is then answered as a retry.
      const raced = await this.findForRetry(input.requestId);
      if (!raced) throw error;
      return this.retry(user, bookingId, raced, input);
    }
    return this.desk.booking(user, bookingId);
  }

  private async collectOnce(
    user: AuthUser,
    bookingId: string,
    input: WindowDeskPaymentRequest,
  ): Promise<void> {
    const currency = await this.currencies.requireActive(input.currency);
    const amount = dec(input.amount);
    if (!amount.gt(0) || !roundMoney(amount, currency.decimalPlaces).eq(amount)) {
      throw new BadRequestException(
        `The amount must be positive with ${currency.decimalPlaces} decimal places`,
      );
    }
    // Unlocked reads to find the rows to lock; every check is made again under the locks.
    const found = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { shipment: { select: { id: true } }, branch: { select: { timezone: true } } },
    });
    if (!found?.shipment) throw new NotFoundException('Booking not found');
    const shipmentId = found.shipment.id;
    const receiptDate = todayIn(found.branch.timezone);
    await this.prisma.$transaction(async (tx) => {
      // The shipment first, as closing, cancelling and an invoice's approval take it (F211-1).
      await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      const ctx = await authorizeWindowInTx(tx, user, bookingId);
      if (ctx.shipmentId !== shipmentId) throw new NotFoundException('Booking not found');
      if (!user.access.has('window_desk:update', ctx.branchId))
        throw new ForbiddenException('Missing permission');
      const cash = await this.cashAccountInTx(tx, ctx.warehouseId, currency.code);
      // The day's rate (400 without one), read once the window may take the currency.
      const fxRate = await this.fxRates.resolve(currency.code, receiptDate, null);
      await this.approveProFormaInTx(tx, user, shipmentId, currency.code);
      const allocations = await this.allocateInTx(tx, shipmentId, currency.code, amount);
      await this.receipts.createInTx(
        tx,
        user,
        {
          customerId: ctx.customerId,
          branchId: ctx.branchId,
          currency: currency.code,
          decimals: currency.decimalPlaces,
          amount,
          fxRate,
        },
        {
          requestId: input.requestId,
          customerId: ctx.customerId,
          branchId: ctx.branchId,
          receiptDate,
          currency: currency.code,
          amount: amount.toFixed(),
          cashAccountId: cash,
          reference: input.reference ?? null,
          notes: null,
          allocations: allocations.map((a) => ({ invoiceId: a.id, amount: a.amount.toFixed() })),
        },
      );
      // Plan 06 ب6: the credit check is the last step of any transaction approving an invoice.
      await this.credit.requireWithinLimitInTx(tx, ctx.customerId);
    });
  }

  /** The window's cash account for the currency, share-locked; 409 when it has none. */
  private async cashAccountInTx(tx: Tx, warehouseId: string, currency: string): Promise<string> {
    const rows = await tx.$queryRaw<{ account_id: string }[]>`
      SELECT "account_id"::text AS "account_id" FROM "window_cash_accounts"
      WHERE "warehouse_id" = ${warehouseId}::uuid AND "currency" = ${currency} FOR SHARE`;
    const row = rows[0];
    if (!row)
      throw codedRefusal(
        HttpStatus.CONFLICT,
        'WINDOW_NO_CASH_ACCOUNT',
        `This window has no cash account for ${currency}: ask NOLON's accountant to set one`,
        { currency },
      );
    return row.account_id;
  }

  /**
   * Owner, 2026-11-05: the booking's MAIN invoice stays pro forma (a draft) until the customer
   * pays at the window; the payment approves it, numbered and posted as any approval, with the
   * window's user as the one who started it. Only the MAIN draft, in the payment's currency.
   */
  private async approveProFormaInTx(
    tx: Tx,
    user: AuthUser,
    shipmentId: string,
    currency: string,
  ): Promise<void> {
    const draft = await tx.customerInvoice.findFirst({
      where: { shipmentId, kind: 'MAIN', status: 'DRAFT', currency },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!draft) return;
    await this.invoices.approveInTx(tx, user, draft.id, shipmentId, {
      approvedById: null,
      approvalSource: 'WINDOW_PAYMENT',
    });
  }

  /**
   * Plan 13 section 4 (F202-2): the whole amount over the shipment's approved invoices in the
   * currency (MAIN first, then additional by invoice date, then number), each up to its balance,
   * read under the invoices' locks. More than they owe: 409 WINDOW_OVER_BALANCE.
   */
  private async allocateInTx(
    tx: Tx,
    shipmentId: string,
    currency: string,
    amount: Prisma.Decimal,
  ): Promise<{ id: string; amount: Prisma.Decimal }[]> {
    const ids = await tx.customerInvoice.findMany({
      where: { shipmentId, currency, status: 'APPROVED' },
      select: { id: true },
    });
    const locked = await lockInvoices(tx, ids.map((i) => i.id).sort());
    const kinds = await tx.customerInvoice.findMany({
      where: { id: { in: [...locked.keys()] } },
      select: { id: true, kind: true },
    });
    const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
    const open = [...locked.values()]
      .map((i) => ({
        id: i.id,
        main: kindOf.get(i.id) === 'MAIN',
        date: i.invoiceDate.getTime(),
        number: i.number ?? '',
        balance: i.total.minus(i.paidAmount).minus(i.creditedAmount),
      }))
      .filter((i) => i.balance.gt(0))
      .sort(
        (a, b) =>
          Number(b.main) - Number(a.main) ||
          a.date - b.date ||
          a.number.localeCompare(b.number) ||
          a.id.localeCompare(b.id),
      );
    const owed = open.reduce((sum, i) => sum.plus(i.balance), ZERO);
    if (!owed.gt(0))
      throw codedRefusal(
        HttpStatus.CONFLICT,
        'WINDOW_NOTHING_TO_COLLECT',
        `Nothing is owed on this booking in ${currency}`,
        { currency },
      );
    if (amount.gt(owed))
      throw codedRefusal(
        HttpStatus.CONFLICT,
        'WINDOW_OVER_BALANCE',
        `The customer owes ${owed.toFixed()} ${currency} on this booking`,
        { balance: owed.toFixed(), currency },
      );
    let left = amount;
    const shares: { id: string; amount: Prisma.Decimal }[] = [];
    for (const invoice of open) {
      if (!left.gt(0)) break;
      const share = Prisma.Decimal.min(invoice.balance, left);
      shares.push({ id: invoice.id, amount: share });
      left = left.minus(share);
    }
    return shares;
  }

  private findForRetry(id: string) {
    return this.prisma.receipt.findUnique({
      where: { id },
      select: {
        createdById: true,
        currency: true,
        amount: true,
        reference: true,
        allocations: {
          select: { invoice: { select: { shipment: { select: { bookingId: true } } } } },
        },
      },
    });
  }

  /**
   * The same user sending the same payment for the same booking again gets the booking as it is
   * now; anything else under the id is 409 REQUEST_ID_REUSED (it says nothing about the receipt).
   */
  private async retry(
    user: AuthUser,
    bookingId: string,
    done: NonNullable<Awaited<ReturnType<WindowCollectService['findForRetry']>>>,
    input: WindowDeskPaymentRequest,
  ): Promise<WindowDeskBookingDto> {
    const same =
      done.createdById === user.id &&
      done.currency === input.currency &&
      done.amount.eq(dec(input.amount)) &&
      done.reference === (input.reference ?? null) &&
      done.allocations.length > 0 &&
      done.allocations.every((a) => a.invoice.shipment?.bookingId === bookingId);
    if (!same) throw new ConflictException('This request id was already used: send a new id');
    return this.desk.booking(user, bookingId);
  }
}
