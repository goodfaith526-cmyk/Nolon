import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BillableTripDto, TripExpenseRequest } from '@nolon/shared';
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
import { FleetService } from './fleet.service.js';
import { forbidDriverOnly, forbidHiddenCosts, lockTrip, tripScope } from './trip-scope.js';
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
 * Rule 11a: an approved carrier bill clears the accrual; the trip keeps the bill that did
 * (carrierBillId), so it is cleared once. The payables module calls the helpers below.
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
    private readonly fleet: FleetService,
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
    forbidHiddenCosts(user);
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
    forbidHiddenCosts(user);
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

  /**
   * Completed external trips of carriers linked to `supplierId` whose accrual no bill has cleared
   * yet, in the user's branches (or `branchId`): what a carrier bill can settle.
   */
  async billableTrips(
    user: AuthUser,
    supplierId: string,
    branchId?: string,
  ): Promise<BillableTripDto[]> {
    const trips = await this.prisma.trip.findMany({
      where: {
        ...tripScope(user),
        ...(branchId ? { branchId } : {}),
        kind: 'EXTERNAL',
        status: 'COMPLETED',
        accrualEntryId: { not: null },
        carrierBillId: null,
        carrier: { supplierId },
      },
      include: { carrier: { select: { name: true } }, branch: { select: { timezone: true } } },
      orderBy: { number: 'asc' },
      take: 200,
    });
    return trips.flatMap((t) =>
      t.agreedCost && t.currency
        ? [
            {
              tripId: t.id,
              tripNumber: t.number,
              branchId: t.branchId,
              carrierName: t.carrier?.name ?? '',
              completedOn: t.completedAt ? todayIn(t.branch.timezone, t.completedAt) : null,
              currency: t.currency,
              agreedCost: t.agreedCost.toFixed(),
            },
          ]
        : [],
    );
  }

  /** For a draft bill line: 404 unless the user may see the trip; its number and branch. */
  async requireBillableTrip(
    user: AuthUser,
    tripId: string,
  ): Promise<{ id: string; number: string; branchId: string }> {
    forbidDriverOnly(user, 'bill trips');
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, ...tripScope(user) },
      select: { id: true, number: true, branchId: true, kind: true },
    });
    if (!trip) throw new NotFoundException('Trip not found');
    if (trip.kind !== 'EXTERNAL') {
      throw new BadRequestException(`Trip ${trip.number} is not an external carrier's trip`);
    }
    return trip;
  }

  /**
   * Rule 11a, inside the approving transaction of carrier bill `bill`: locks each trip (in id
   * order, after the bill), then share-locks their carriers (in id order), checks each trip can be
   * cleared by this bill and marks it billed. A trip is cleared once: it must be a completed external trip of the bill's branch with its accrual
   * posted, its carrier linked to the bill's supplier, accrued in the bill's currency, and not
   * cleared by another bill yet.
   */
  async markCarrierBilled(
    tx: Tx,
    tripIds: readonly string[],
    bill: { id: string; supplierId: string; branchId: string; currency: string },
  ): Promise<Map<string, { number: string; accrualEntryId: string }>> {
    const result = new Map<string, { number: string; accrualEntryId: string }>();
    // Every trip first, then their carriers, each in id order: the same order everywhere, so two
    // bills cannot deadlock, and a carrier's link to a supplier is read under a lock that a
    // concurrent link change (FleetService.setCarrierSupplier, FOR UPDATE) must wait for.
    const trips: Trip[] = [];
    for (const id of [...new Set(tripIds)].sort()) trips.push(await lockTrip(tx, id));
    const links = await this.fleet.lockCarrierSuppliers(
      tx,
      trips.flatMap((trip) => (trip.carrierId ? [trip.carrierId] : [])),
    );
    for (const trip of trips) {
      const id = trip.id;
      const supplierId = trip.carrierId ? (links.get(trip.carrierId) ?? null) : null;
      if (trip.kind !== 'EXTERNAL' || trip.status !== 'COMPLETED' || !trip.accrualEntryId) {
        throw new ConflictException(`Trip ${trip.number} is not a completed external trip`);
      }
      if (trip.branchId !== bill.branchId) {
        throw new BadRequestException(`Trip ${trip.number} belongs to another branch`);
      }
      if (supplierId !== bill.supplierId) {
        throw new BadRequestException(
          `Trip ${trip.number}'s carrier is not linked to this supplier`,
        );
      }
      if (trip.currency !== bill.currency) {
        throw new BadRequestException(
          `Trip ${trip.number} was agreed in ${trip.currency ?? '—'}; bill it in that currency`,
        );
      }
      if (trip.carrierBillId !== null) {
        throw new ConflictException(`Trip ${trip.number} is already settled by another bill`);
      }
      await tx.trip.update({ where: { id }, data: { carrierBillId: bill.id } });
      result.set(id, { number: trip.number, accrualEntryId: trip.accrualEntryId });
    }
    return result;
  }

  /** A cancelled carrier bill gives its trips' accruals back: they can be billed again. */
  async releaseCarrierBill(tx: Tx, billId: string): Promise<void> {
    const trips = await tx.trip.findMany({
      where: { carrierBillId: billId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const { id } of trips) {
      await lockTrip(tx, id);
      await tx.trip.update({ where: { id }, data: { carrierBillId: null } });
    }
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
