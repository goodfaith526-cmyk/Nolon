import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TripExpenseRequest } from '@nolon/shared';
import { AccountsService } from '../accounting/accounts.service.js';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { dec, roundMoney } from '../common/money.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { JournalEntry, Prisma, Trip } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { forbidDriverOnly, lockTrip, tripScope } from './trip-scope.js';
import {
  type CostShare,
  measuresOf,
  sameExpenseRequest,
  splitTripCost,
  takesExpenses,
} from './transport-rules.js';

type Tx = Prisma.TransactionClient;

/**
 * Trip costs in the books (annex C):
 * - rule 10, an own-vehicle trip's expenses (driver allowances, road fees...): each expense posts
 *   at once, debit transport cost per shipment, credit the cash or bank account it was paid from;
 * - rule 11, an external carrier's trip: completing it accrues the agreed cost, debit transport
 *   cost per shipment, credit accrued transport costs.
 * The cost is shared by the trip's shipments (transport-rules splitTripCost) and each share is a
 * journal line with the shipment as its dimension, so it reaches the shipment's profitability.
 * Rule 11a (the carrier's bill clearing the accrual) comes with supplier bills.
 */
@Injectable()
export class TripCostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly autoJournal: AutoJournalService,
    private readonly accounts: AccountsService,
    private readonly fxRates: FxRatesService,
    private readonly currencies: CurrenciesService,
  ) {}

  /**
   * Rule 11, inside the completion's transaction (the caller holds the trip lock): posts the
   * accrual of the agreed cost, dated the day the trip was completed in its branch, at the rate
   * table's rate for that day.
   */
  async accrueInTx(
    tx: Tx,
    user: AuthUser,
    trip: Trip,
    shipmentIds: readonly string[],
    completedAt: Date,
  ): Promise<JournalEntry> {
    if (!trip.agreedCost || !trip.currency) throw new Error('An external trip has an agreed cost');
    const branch = await tx.branch.findUniqueOrThrow({
      where: { id: trip.branchId },
      select: { timezone: true },
    });
    const date = todayIn(branch.timezone, completedAt);
    // Recorded on the trip when it was planned: completion does not depend on it still being active.
    const currency = await this.currencies.requireRecorded(trip.currency);
    const fxRate = await this.fxRates.resolve(currency.code, date);
    const shares = await this.split(tx, trip.agreedCost, currency.decimalPlaces, shipmentIds);
    return this.autoJournal.tripAccrued(
      tx,
      {
        sourceId: trip.id,
        tripNumber: trip.number,
        branchId: trip.branchId,
        entryDate: date,
        currency: currency.code,
        fxRate,
        amount: trip.agreedCost,
        description: 'Accrued carrier cost',
        shares,
      },
      user.id,
    );
  }

  /**
   * Rule 10: records an expense of an own-vehicle trip and posts its entry. The client's
   * `requestId` becomes the expense id, so a retry or a double submit of the same form (they
   * queue on the trip lock) finds the first expense and posts nothing more. The currency is
   * share-locked and checked inside the transaction, so a concurrent deactivation is seen.
   */
  async addExpense(user: AuthUser, tripId: string, input: TripExpenseRequest): Promise<void> {
    forbidDriverOnly(user, 'pay trip expenses');
    const existing = await this.findScoped(user, tripId);
    if (existing.kind !== 'OWN') {
      throw new ConflictException(
        "An external trip's cost is its agreed amount, accrued on completion",
      );
    }
    const expenseId = input.requestId;
    try {
      await this.prisma.$transaction(async (tx) => {
        const trip = await lockTrip(tx, tripId);
        const done = await tx.tripExpense.findUnique({
          where: { id: expenseId },
          select: {
            tripId: true,
            expenseDate: true,
            description: true,
            amount: true,
            currency: true,
            fxRate: true,
            cashAccountId: true,
          },
        });
        if (done) {
          // An exact retry gets the first result; anything else reusing the id is refused.
          const stored = { ...done, expenseDate: fromDbDate(done.expenseDate) };
          if (!sameExpenseRequest(stored, tripId, input)) throw duplicateRequest();
          return;
        }
        if (!takesExpenses(trip.status)) {
          throw new ConflictException('A cancelled trip takes no expenses');
        }
        const currency = await this.currencies.requireActiveInTx(tx, input.currency);
        const fxRate = await this.fxRates.resolve(currency.code, input.expenseDate, input.fxRate);
        const amount = dec(input.amount);
        if (!amount.gt(0) || !roundMoney(amount, currency.decimalPlaces).eq(amount)) {
          throw new BadRequestException(
            `Amount must be positive with ${currency.decimalPlaces} decimal places`,
          );
        }
        await this.accounts.requireCash(tx, input.cashAccountId, trip.branchId, currency.code);
        const shipmentIds = (
          await tx.tripShipment.findMany({ where: { tripId }, select: { shipmentId: true } })
        ).map((l) => l.shipmentId);
        const shares = await this.split(tx, amount, currency.decimalPlaces, shipmentIds);
        const year = input.expenseDate.slice(0, 4);
        const number = formatDocumentNumber(
          'TEX',
          await nextSequenceValue(tx, 'TRIP_EXPENSE', year),
          year,
        );
        const entry = await this.autoJournal.tripExpensePosted(
          tx,
          {
            sourceId: expenseId,
            number,
            tripNumber: trip.number,
            branchId: trip.branchId,
            entryDate: input.expenseDate,
            currency: currency.code,
            fxRate,
            amount,
            description: input.description,
            cashAccountId: input.cashAccountId,
            shares,
          },
          user.id,
        );
        await tx.tripExpense.create({
          data: {
            id: expenseId,
            number,
            branchId: trip.branchId,
            tripId,
            expenseDate: toDbDate(input.expenseDate),
            description: input.description,
            amount,
            currency: currency.code,
            fxRate,
            cashAccountId: input.cashAccountId,
            journalEntryId: entry.id,
            createdById: user.id,
          },
        });
      });
    } catch (error) {
      // The same request id on another trip: the two trips' locks do not serialize them.
      if (isUniqueViolation(error)) throw duplicateRequest();
      throw error;
    }
  }

  /** Cancels a trip expense: posts the reversing entry, dated today in the trip's branch. */
  async cancelExpense(
    user: AuthUser,
    tripId: string,
    expenseId: string,
    reason: string,
  ): Promise<void> {
    forbidDriverOnly(user, 'cancel trip expenses');
    const trip = await this.findScoped(user, tripId);
    const expense = await this.prisma.tripExpense.findFirst({
      where: { id: expenseId, tripId: trip.id },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: trip.branchId },
      select: { timezone: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await lockTrip(tx, tripId);
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "trip_expenses"
        WHERE "id" = ${expenseId}::uuid FOR UPDATE`;
      if (rows[0]?.status !== 'POSTED') {
        throw new ConflictException('The expense is already cancelled');
      }
      const reversal = await this.autoJournal.reverseDocumentEntry(
        tx,
        expense.journalEntryId,
        todayIn(branch.timezone),
        user.id,
        `Cancellation of trip expense ${expense.number}: ${reason}`,
      );
      await tx.tripExpense.update({
        where: { id: expenseId },
        data: {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledAt: new Date(),
          cancelledById: user.id,
          cancelJournalEntryId: reversal.id,
        },
      });
    });
  }

  /** The trip's cost shares, from its shipments' cargo lines (CBM, else weight, else equal). */
  private async split(
    tx: Tx,
    amount: Prisma.Decimal,
    decimalPlaces: number,
    shipmentIds: readonly string[],
  ): Promise<CostShare[]> {
    if (shipmentIds.length === 0) throw new ConflictException('The trip carries no shipment');
    const cargo = await this.shipments.cargoMeasuresInTx(tx, shipmentIds);
    return splitTripCost(
      amount,
      decimalPlaces,
      cargo.map((s) => measuresOf(s.id, s.items)),
    ).shares;
  }

  private async findScoped(user: AuthUser, id: string): Promise<Trip> {
    const trip = await this.prisma.trip.findFirst({ where: { id, ...tripScope(user) } });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }
}

function duplicateRequest(): ConflictException {
  return new ConflictException(
    'This request id was already used for a different expense: send a new id for a new expense',
  );
}
