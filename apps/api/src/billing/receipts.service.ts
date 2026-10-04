import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateReceiptRequest,
  Page,
  ReceiptDto,
  ReceiptStatus,
  ReceiptSummaryDto,
} from '@nolon/shared';
import { randomUUID } from 'node:crypto';
import { AccountsService } from '../accounting/accounts.service.js';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import { USD_DECIMALS } from '../accounting/journal-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { ZERO, dec, roundMoney } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { relievedUsd } from './invoice-math.js';

export interface ReceiptFilters extends PageQuery {
  status?: ReceiptStatus;
  customerId?: string;
}

type Tx = Prisma.TransactionClient;

const details = {
  customer: { select: { name: true } },
  cashAccount: { select: { code: true, nameEn: true, nameAr: true } },
  journalEntry: { select: { number: true } },
  cancelJournal: { select: { number: true } },
  allocations: {
    include: { invoice: { select: { number: true } } },
    orderBy: { invoice: { number: 'asc' } },
  },
} satisfies Prisma.ReceiptInclude;

type ReceiptWithDetails = Prisma.ReceiptGetPayload<{ include: typeof details }>;

/**
 * Receipts from customers (annex C rules 3-4 and section 3). Recording a receipt posts its entry
 * at once: money into a cash or bank account, paying approved invoices of the same customer and
 * currency, with any rest held as a customer advance. A mistaken receipt is cancelled, which
 * posts the reversing entry and gives the amounts back to the invoices.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly accounts: AccountsService,
    private readonly fxRates: FxRatesService,
    private readonly customers: CustomersService,
    private readonly currencies: CurrenciesService,
  ) {}

  async list(user: AuthUser, filters: ReceiptFilters): Promise<Page<ReceiptSummaryDto>> {
    const where: Prisma.ReceiptWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { reference: { contains: filters.q, mode: 'insensitive' } },
              { customer: { name: { contains: filters.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.receipt.findMany({
        where,
        include: details,
        orderBy: [{ receiptDate: 'desc' }, { number: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.receipt.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<ReceiptDto> {
    return toDto(await this.findScoped(user, id), user);
  }

  async create(user: AuthUser, input: CreateReceiptRequest): Promise<ReceiptDto> {
    const customer = await this.customers.requireCustomer(user, input.customerId);
    const branchId = customer.branchId;
    const currency = await this.currencies.requireActive(input.currency);
    const amount = dec(input.amount);
    const decimals = currency.decimalPlaces;
    if (!amount.gt(0) || !roundMoney(amount, decimals).eq(amount)) {
      throw new BadRequestException(`Amount must be positive with ${decimals} decimal places`);
    }
    const invoiceIds = input.allocations.map((a) => a.invoiceId);
    if (new Set(invoiceIds).size !== invoiceIds.length) {
      throw new BadRequestException('Each invoice appears once');
    }
    const allocated = input.allocations.reduce((sum, a) => sum.plus(dec(a.amount)), ZERO);
    if (allocated.gt(amount)) {
      throw new BadRequestException('The allocations are more than the amount received');
    }
    const fxRate = await this.fxRates.resolve(currency.code, input.receiptDate, input.fxRate);
    const receiptId = randomUUID();

    await this.prisma.$transaction(async (tx) => {
      await this.accounts.requireCash(tx, input.cashAccountId, branchId, currency.code);
      // Lock the invoices in a fixed order so two receipts for the same invoices cannot deadlock.
      const invoices = await lockInvoices(tx, [...invoiceIds].sort());
      const allocations = input.allocations.map((a) => {
        const invoice = invoices.get(a.invoiceId);
        if (!invoice || invoice.customerId !== customer.id) {
          throw new BadRequestException('An allocation is to an invoice of another customer');
        }
        if (invoice.status !== 'APPROVED') {
          throw new BadRequestException(`Invoice ${invoice.number ?? ''} is not approved`);
        }
        if (invoice.currency !== currency.code) {
          throw new BadRequestException(
            `Invoice ${invoice.number ?? ''} is in ${invoice.currency}; receive it in that currency`,
          );
        }
        const share = dec(a.amount);
        const outstanding = invoice.total.minus(invoice.paidAmount);
        if (!share.gt(0) || !roundMoney(share, decimals).eq(share)) {
          throw new BadRequestException('Allocated amounts must be positive');
        }
        if (share.gt(outstanding)) {
          throw new BadRequestException(
            `Invoice ${invoice.number ?? ''} has ${outstanding.toFixed()} ${invoice.currency} left`,
          );
        }
        return {
          invoice,
          amount: share,
          relievedUsd: relievedUsd(invoice, share, invoice.fxRate, invoice.currency, USD_DECIMALS),
        };
      });

      const year = input.receiptDate.slice(0, 4);
      const number = formatDocumentNumber('RC', await nextSequenceValue(tx, 'RECEIPT', year), year);
      const entry = await this.autoJournal.receiptRecorded(
        tx,
        {
          id: receiptId,
          number,
          branchId,
          customerId: customer.id,
          receiptDate: toDbDate(input.receiptDate),
          currency: currency.code,
          fxRate,
          amount,
          cashAccountId: input.cashAccountId,
          allocations: allocations.map((a) => ({
            invoiceNumber: a.invoice.number ?? '',
            receivableAccountId: requireReceivable(a.invoice),
            shipmentId: a.invoice.shipmentId,
            invoiceFxRate: a.invoice.fxRate,
            amount: a.amount,
            relievedUsd: a.relievedUsd,
          })),
        },
        user.id,
      );
      await tx.receipt.create({
        data: {
          id: receiptId,
          number,
          branchId,
          customerId: customer.id,
          receiptDate: toDbDate(input.receiptDate),
          currency: currency.code,
          fxRate,
          amount,
          cashAccountId: input.cashAccountId,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          journalEntryId: entry.id,
          createdById: user.id,
          allocations: {
            create: allocations.map((a) => ({
              invoiceId: a.invoice.id,
              amount: a.amount,
              relievedUsd: a.relievedUsd,
            })),
          },
        },
      });
      for (const a of allocations) {
        await tx.customerInvoice.update({
          where: { id: a.invoice.id },
          data: {
            paidAmount: { increment: a.amount },
            paidUsd: { increment: a.relievedUsd },
          },
        });
      }
    });
    return this.get(user, receiptId);
  }

  /**
   * Posts the reversing entry, dated today in the branch, and gives the paid amounts back to the
   * invoices.
   */
  async cancel(user: AuthUser, id: string, reason: string): Promise<ReceiptDto> {
    const existing = await this.findScoped(user, id);
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: existing.branchId } });
    const today = todayIn(branch.timezone);
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "receipts" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (rows[0]?.status !== 'POSTED')
        throw new ConflictException('The receipt is already cancelled');
      const allocations = await tx.receiptAllocation.findMany({ where: { receiptId: id } });
      await lockInvoices(tx, allocations.map((a) => a.invoiceId).sort());
      const reversal = await this.autoJournal.reverseDocumentEntry(
        tx,
        existing.journalEntryId,
        today,
        user.id,
        `Cancellation of receipt ${existing.number}: ${reason}`,
      );
      for (const a of allocations) {
        await tx.customerInvoice.update({
          where: { id: a.invoiceId },
          data: {
            paidAmount: { decrement: a.amount },
            paidUsd: { decrement: a.relievedUsd },
          },
        });
      }
      await tx.receipt.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: reason,
          cancelledAt: new Date(),
          cancelledById: user.id,
          cancelJournalEntryId: reversal.id,
        },
      });
    });
    return this.get(user, id);
  }

  private async findScoped(user: AuthUser, id: string): Promise<ReceiptWithDetails> {
    const receipt = await this.prisma.receipt.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!receipt) throw new NotFoundException('Receipt not found');
    return receipt;
  }
}

interface LockedInvoice {
  id: string;
  number: string | null;
  customerId: string;
  shipmentId: string;
  status: string;
  receivableAccountId: string | null;
  currency: string;
  fxRate: Prisma.Decimal;
  total: Prisma.Decimal;
  totalUsd: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  paidUsd: Prisma.Decimal;
}

async function lockInvoices(tx: Tx, ids: readonly string[]): Promise<Map<string, LockedInvoice>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<LockedInvoice[]>`
    SELECT "id", "number", "customer_id" AS "customerId", "shipment_id" AS "shipmentId",
           "status"::text AS "status", "currency", "fx_rate" AS "fxRate", "total",
           "receivable_account_id" AS "receivableAccountId",
           "total_usd" AS "totalUsd", "paid_amount" AS "paidAmount", "paid_usd" AS "paidUsd"
    FROM "customer_invoices"
    WHERE "id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY "id"
    FOR UPDATE`;
  return new Map(
    rows.map((r) => [
      r.id,
      {
        ...r,
        fxRate: new Prisma.Decimal(r.fxRate),
        total: new Prisma.Decimal(r.total),
        totalUsd: new Prisma.Decimal(r.totalUsd),
        paidAmount: new Prisma.Decimal(r.paidAmount),
        paidUsd: new Prisma.Decimal(r.paidUsd),
      },
    ]),
  );
}

function toSummary(r: ReceiptWithDetails): ReceiptSummaryDto {
  const allocated = r.allocations.reduce((sum, a) => sum.plus(a.amount), ZERO);
  return {
    id: r.id,
    number: r.number,
    branchId: r.branchId,
    customerId: r.customerId,
    customerName: r.customer.name,
    receiptDate: fromDbDate(r.receiptDate),
    currency: r.currency,
    amount: r.amount.toFixed(),
    allocated: allocated.toFixed(),
    unallocated: r.amount.minus(allocated).toFixed(),
    status: r.status,
  };
}

function toDto(r: ReceiptWithDetails, user: AuthUser): ReceiptDto {
  return {
    ...toSummary(r),
    fxRate: r.fxRate.toFixed(),
    cashAccountId: r.cashAccountId,
    cashAccountCode: r.cashAccount.code,
    cashAccountNameEn: r.cashAccount.nameEn,
    cashAccountNameAr: r.cashAccount.nameAr,
    reference: r.reference,
    notes: r.notes,
    allocations: r.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoice.number ?? '',
      amount: a.amount.toFixed(),
      relievedUsd: a.relievedUsd.toFixed(),
    })),
    journalEntryId: r.journalEntryId,
    journalEntryNumber: r.journalEntry.number,
    cancelJournalEntryId: r.cancelJournalEntryId,
    cancelJournalEntryNumber: r.cancelJournal?.number ?? null,
    cancelReason: r.cancelReason,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    actions: { canCancel: r.status === 'POSTED' && user.permissions.has('receipts:cancel') },
  };
}

/** Every approved invoice keeps the receivable account it was posted to (a database check). */
function requireReceivable(invoice: LockedInvoice): string {
  if (!invoice.receivableAccountId) {
    throw new Error(`Invoice ${invoice.number ?? invoice.id} has no receivable account`);
  }
  return invoice.receivableAccountId;
}
