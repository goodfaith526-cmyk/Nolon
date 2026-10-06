import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { fromDbDate } from '../common/dates.js';
import { toDecimalString } from '../common/money.js';
import { splitContainerCost } from '../consolidations/consolidation-rules.js';
import {
  type ClosedContainer,
  type ContainerCostHandler,
  type ContainerCostsView,
  ContainerCostsRegistry,
} from '../consolidations/container-costs.registry.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/** A container cost line of an approved bill, as rule 13 needs it. */
export interface ApprovedContainerCost {
  lineId: string;
  consolidationId: string;
  chargeTypeCode: string;
  amount: Prisma.Decimal;
  bill: {
    number: string;
    branchId: string;
    supplierId: string;
    currency: string;
    fxRate: Prisma.Decimal;
    billDate: Date;
    journalEntryId: string;
  };
}

/**
 * Container costs (annex C rules 7a and 13): supplier bill lines charging a consolidated
 * container. Each is shared between the container's shipments by its own entry once the container
 * is closed, so cancelling a bill reverses exactly the shares of its own costs.
 */
@Injectable()
export class ContainerCostsService implements ContainerCostHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly currencies: CurrenciesService,
    private readonly registry: ContainerCostsRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Closing the container (its row is locked): every approved cost not shared out yet. The bills
   * are share-locked, in id order, so none is cancelled until the close commits.
   */
  async allocatePendingInTx(tx: Tx, user: AuthUser, container: ClosedContainer): Promise<void> {
    await tx.$queryRaw`
      SELECT b."id" FROM "supplier_bills" b
      JOIN "supplier_bill_lines" l ON l."bill_id" = b."id"
      WHERE l."consolidation_id" = ${container.id}::uuid AND b."status" = 'APPROVED'
      ORDER BY b."id" FOR SHARE OF b`;
    const lines = await tx.supplierBillLine.findMany({
      where: {
        consolidationId: container.id,
        allocationEntryId: null,
        bill: { status: 'APPROVED' },
      },
      include: { bill: true },
      orderBy: [{ billId: 'asc' }, { lineNo: 'asc' }],
    });
    for (const line of lines) {
      const { bill } = line;
      if (!line.chargeTypeCode || !bill.number || !bill.journalEntryId) {
        throw new Error('An approved container cost has its charge, number and entry');
      }
      await this.allocateInTx(
        tx,
        user,
        {
          lineId: line.id,
          consolidationId: container.id,
          chargeTypeCode: line.chargeTypeCode,
          amount: line.amount,
          bill: {
            number: bill.number,
            branchId: bill.branchId,
            supplierId: bill.supplierId,
            currency: bill.currency,
            fxRate: bill.fxRate,
            billDate: bill.billDate,
            journalEntryId: bill.journalEntryId,
          },
        },
        container,
      );
    }
  }

  /**
   * Rule 13 for one cost: shared by the frozen basis, dated the later of the close and the bill
   * date, in the bill's currency and rate; the line keeps its entry.
   */
  async allocateInTx(
    tx: Tx,
    user: AuthUser,
    cost: ApprovedContainerCost,
    container: ClosedContainer,
  ): Promise<void> {
    const currency = await this.currencies.requireRecorded(cost.bill.currency);
    const billDate = fromDbDate(cost.bill.billDate);
    const entry = await this.autoJournal.containerCostAllocated(
      tx,
      {
        billLineId: cost.lineId,
        billNumber: cost.bill.number,
        consolidationId: container.id,
        consolidationNumber: container.number,
        branchId: cost.bill.branchId,
        supplierId: cost.bill.supplierId,
        entryDate: billDate > container.closedOn ? billDate : container.closedOn,
        currency: cost.bill.currency,
        fxRate: cost.bill.fxRate,
        amount: cost.amount,
        chargeTypeCode: cost.chargeTypeCode,
        clearingAccountId: await this.autoJournal.clearingAccountOf(
          tx,
          cost.bill.journalEntryId,
          container.id,
        ),
        shares: splitContainerCost(cost.amount, currency.decimalPlaces, container.shipments),
      },
      user.id,
    );
    const { count } = await tx.supplierBillLine.updateMany({
      where: { id: cost.lineId, allocationEntryId: null },
      data: { allocationEntryId: entry.id },
    });
    if (count !== 1) throw new Error('The container cost was already shared out');
  }

  approvedCostCountInTx(tx: Tx, consolidationId: string): Promise<number> {
    return tx.supplierBillLine.count({
      where: { consolidationId, bill: { status: 'APPROVED' } },
    });
  }

  async view(consolidationId: string): Promise<ContainerCostsView> {
    const lines = await this.prisma.supplierBillLine.findMany({
      where: { consolidationId, bill: { status: 'APPROVED' } },
      include: {
        bill: { select: { id: true, number: true, currency: true, supplier: true } },
        allocationEntry: { select: { number: true } },
      },
      orderBy: [{ bill: { number: 'asc' } }, { lineNo: 'asc' }],
    });
    const [allocatedUsd, clearingBalanceUsd] = await Promise.all([
      this.autoJournal.debitUsdByShipment(
        lines.flatMap((l) => (l.allocationEntryId ? [l.allocationEntryId] : [])),
      ),
      this.autoJournal.consolidationClearingUsd(consolidationId),
    ]);
    return {
      costs: lines.map((l) => ({
        billId: l.bill.id,
        billNumber: l.bill.number,
        supplierName: l.bill.supplier.name,
        lineNo: l.lineNo,
        chargeTypeCode: l.chargeTypeCode ?? '',
        description: l.description,
        currency: l.bill.currency,
        amount: toDecimalString(l.amount),
        allocationEntryId: l.allocationEntryId,
        allocationEntryNumber: l.allocationEntry?.number ?? null,
      })),
      allocatedUsd,
      clearingBalanceUsd,
    };
  }
}
