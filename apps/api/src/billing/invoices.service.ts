import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CustomerInvoiceDto,
  CustomerInvoiceInput,
  CustomerInvoiceSummaryDto,
  InvoiceStatus,
  OpeningCustomerItemRequest,
  Page,
  PaymentStatus,
} from '@nolon/shared';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import { toUsd } from '../accounting/journal-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { type Decimal, dec, roundMoney } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { type CustomerInvoice, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { computeInvoiceAmounts } from './invoice-math.js';

export interface InvoiceFilters extends PageQuery {
  status?: InvoiceStatus;
  customerId?: string;
  shipmentId?: string;
  /** Approved invoices with a balance left. */
  openOnly?: boolean;
}

type Tx = Prisma.TransactionClient;

const details = {
  lines: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  shipment: { select: { number: true } },
  journalEntry: { select: { number: true } },
  allocations: {
    include: {
      receipt: { select: { id: true, number: true, receiptDate: true, status: true } },
    },
    orderBy: { receipt: { receiptDate: 'asc' } },
  },
  creditNotes: {
    select: { id: true, number: true, creditDate: true, amount: true, status: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.CustomerInvoiceInclude;

type InvoiceWithDetails = Prisma.CustomerInvoiceGetPayload<{ include: typeof details }>;

/**
 * Customer invoices (scope 13, annex C rules 1-2). An invoice bills one shipment, in the
 * shipment's branch. It is edited as a DRAFT; approving it numbers it and posts its entry in the
 * same transaction. An approved invoice is not edited: it is corrected by a credit note.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly fxRates: FxRatesService,
    private readonly shipments: ShipmentsService,
    private readonly quotations: QuotationsService,
    private readonly customers: CustomersService,
    private readonly currencies: CurrenciesService,
    private readonly masterData: MasterDataService,
  ) {}

  async list(user: AuthUser, filters: InvoiceFilters): Promise<Page<CustomerInvoiceSummaryDto>> {
    const where: Prisma.CustomerInvoiceWhereInput = {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.shipmentId ? { shipmentId: filters.shipmentId } : {}),
      ...(filters.openOnly
        ? { status: 'APPROVED', id: { in: await this.openInvoiceIds(user, filters.customerId) } }
        : {}),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { customer: { name: { contains: filters.q, mode: 'insensitive' } } },
              { shipment: { number: { contains: filters.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.customerInvoice.findMany({
        where,
        include: details,
        orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.customerInvoice.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: filters.page, pageSize: filters.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<CustomerInvoiceDto> {
    return toDto(await this.findScoped(user, id), user);
  }

  /** Approved invoices of the user's branches with a balance left (payments and credit notes). */
  private async openInvoiceIds(user: AuthUser, customerId?: string): Promise<string[]> {
    if (user.allowedBranchIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_invoices"
      WHERE "status" = 'APPROVED'
        AND "paid_amount" + "credited_amount" < "total"
        AND "branch_id" IN (${Prisma.join(user.allowedBranchIds.map((b) => Prisma.sql`${b}::uuid`))})
        ${customerId ? Prisma.sql`AND "customer_id" = ${customerId}::uuid` : Prisma.empty}`;
    return rows.map((r) => r.id);
  }

  /**
   * Annex C rule 15: a customer's invoice still open at go-live, recorded as an approved opening
   * item (no shipment, no lines) and posted at once against opening equity. Receipts and credit
   * notes then settle it like any invoice. The client's `requestId` becomes its id, so a retry
   * returns the first item.
   */
  async createOpeningItem(
    user: AuthUser,
    input: OpeningCustomerItemRequest,
  ): Promise<CustomerInvoiceDto> {
    const customer = await this.customers.requireCustomer(user, input.customerId);
    if (input.dueDate < input.invoiceDate) {
      throw new BadRequestException('The due date is before the invoice date');
    }
    if (input.entryDate < input.invoiceDate) {
      throw new BadRequestException('The opening entry is dated before the invoice');
    }
    const existing = await this.prisma.customerInvoice.findUnique({
      where: { id: input.requestId },
    });
    if (existing) return this.sameOpeningRequest(user, existing, input);
    const amount = dec(input.amount);
    try {
      await this.prisma.$transaction(async (tx) => {
        const currency = await this.currencies.requireActiveInTx(tx, input.currency);
        if (!amount.gt(0) || !roundMoney(amount, currency.decimalPlaces).eq(amount)) {
          throw new BadRequestException(
            `Amount must be positive with ${currency.decimalPlaces} decimal places`,
          );
        }
        const fxRate = await this.fxRates.resolve(currency.code, input.entryDate, input.fxRate);
        const totalUsd = toUsd(amount, fxRate, currency.code);
        const year = input.entryDate.slice(0, 4);
        const number = formatDocumentNumber(
          'OBI',
          await nextSequenceValue(tx, 'OPENING_INVOICE', year),
          year,
        );
        const { entry, receivableAccountId } = await this.autoJournal.openingCustomerItem(
          tx,
          {
            sourceId: input.requestId,
            number,
            reference: input.reference,
            branchId: customer.branchId,
            customerId: customer.id,
            entryDate: input.entryDate,
            currency: currency.code,
            fxRate,
            amount,
            amountUsd: totalUsd,
          },
          user.id,
        );
        await tx.customerInvoice.create({
          data: {
            id: input.requestId,
            number,
            branchId: customer.branchId,
            customerId: customer.id,
            isOpening: true,
            reference: input.reference,
            currency: currency.code,
            fxRate,
            invoiceDate: toDbDate(input.invoiceDate),
            dueDate: toDbDate(input.dueDate),
            status: 'APPROVED',
            total: amount,
            totalUsd,
            journalEntryId: entry.id,
            receivableAccountId,
            createdById: user.id,
            approvedById: user.id,
            approvedAt: new Date(),
          },
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The same request id, posted meanwhile by a concurrent retry.
      const raced = await this.prisma.customerInvoice.findUnique({
        where: { id: input.requestId },
      });
      if (!raced) throw error;
      return this.sameOpeningRequest(user, raced, input);
    }
    return this.get(user, input.requestId);
  }

  private async sameOpeningRequest(
    user: AuthUser,
    existing: CustomerInvoice,
    input: OpeningCustomerItemRequest,
  ): Promise<CustomerInvoiceDto> {
    const same =
      existing.isOpening &&
      existing.customerId === input.customerId &&
      existing.createdById === user.id &&
      existing.currency === input.currency &&
      existing.total.eq(dec(input.amount));
    if (!same) {
      throw new ConflictException('This request id was already used: send a new id');
    }
    return this.get(user, existing.id);
  }

  /**
   * A draft invoice for a shipment, prefilled from the quotation it was booked from: its currency
   * and charge lines. Dated today in the branch; due after the customer's payment terms.
   */
  async createForShipment(user: AuthUser, shipmentId: string): Promise<CustomerInvoiceDto> {
    const shipment = await this.shipments.billingSource(user, shipmentId);
    if (shipment.status === 'CANCELLED') {
      throw new ConflictException('A cancelled shipment is not invoiced');
    }
    const customer = await this.customers.requireCustomer(user, shipment.customerId);
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: shipment.branchId } });
    const quotation = shipment.quotationId
      ? await this.quotations.invoiceSource(shipment.quotationId)
      : null;
    const currencyCode =
      quotation?.currency ?? customer.preferredCurrency ?? branch.defaultCurrency;
    const currency = await this.currencies.requireActive(currencyCode);
    const invoiceDate = todayIn(branch.timezone);
    const fxRate = await this.fxRates.resolve(currency.code, invoiceDate);
    const lines = (quotation?.lines ?? []).map((l) => {
      const exact = roundMoney(l.quantity.times(l.unitPrice), currency.decimalPlaces);
      // Minimum charges and discounts make the quoted total differ from quantity × price; the
      // line then carries the agreed amount as one unit.
      return exact.eq(l.lineTotal)
        ? {
            chargeTypeCode: l.chargeTypeCode,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          }
        : {
            chargeTypeCode: l.chargeTypeCode,
            description: l.description,
            quantity: dec(1),
            unitPrice: l.lineTotal,
          };
    });
    const { lineTotals, total } = computeInvoiceAmounts(lines, currency.decimalPlaces);
    const created = await this.prisma.customerInvoice.create({
      data: {
        branchId: shipment.branchId,
        customerId: shipment.customerId,
        shipmentId: shipment.id,
        currency: currency.code,
        fxRate,
        invoiceDate: toDbDate(invoiceDate),
        dueDate: toDbDate(addDays(invoiceDate, customer.paymentTermsDays)),
        total,
        totalUsd: toUsd(total, fxRate, currency.code),
        createdById: user.id,
        lines: {
          create: lines.map((l, index) => ({
            lineNo: index + 1,
            chargeTypeCode: l.chargeTypeCode,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: lineTotals[index] ?? dec(0),
          })),
        },
      },
      include: details,
    });
    return toDto(created, user);
  }

  /** Drafts only; the lines are replaced as a whole. */
  async update(
    user: AuthUser,
    id: string,
    input: CustomerInvoiceInput,
  ): Promise<CustomerInvoiceDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') throw new ConflictException('Only a draft invoice is edited');
    if (input.dueDate < input.invoiceDate) {
      throw new BadRequestException('The due date is before the invoice date');
    }
    const currency = await this.currencies.requireActive(input.currency);
    for (const line of input.lines) await this.masterData.requireChargeType(line.chargeTypeCode);
    const fxRate = await this.fxRates.resolve(currency.code, input.invoiceDate, input.fxRate);
    const lines = input.lines.map((l) => ({
      ...l,
      quantity: dec(l.quantity),
      unitPrice: dec(l.unitPrice),
    }));
    const { lineTotals, total } = computeInvoiceAmounts(lines, currency.decimalPlaces);
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, 'DRAFT');
      await tx.customerInvoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.customerInvoice.update({
        where: { id },
        data: {
          currency: currency.code,
          fxRate,
          invoiceDate: toDbDate(input.invoiceDate),
          dueDate: toDbDate(input.dueDate),
          notes: input.notes ?? null,
          total,
          totalUsd: toUsd(total, fxRate, currency.code),
          lines: {
            create: lines.map((l, index) => ({
              lineNo: index + 1,
              chargeTypeCode: l.chargeTypeCode,
              description: l.description ?? null,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              lineTotal: lineTotals[index] ?? dec(0),
            })),
          },
        },
      });
    });
    return this.get(user, id);
  }

  /**
   * Numbers the invoice and posts its entry (annex C rules 1-2), together. The invoice date must
   * fall in an open period.
   */
  async approve(user: AuthUser, id: string): Promise<CustomerInvoiceDto> {
    const existing = await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, 'DRAFT');
      const invoice = await tx.customerInvoice.findUniqueOrThrow({
        where: { id },
        include: { lines: { orderBy: { lineNo: 'asc' } }, shipment: { select: { status: true } } },
      });
      if (invoice.lines.length === 0 || !invoice.total.gt(0)) {
        throw new BadRequestException('An invoice needs at least one line with an amount');
      }
      if (!invoice.shipment || !invoice.shipmentId) throw new Error('A draft bills a shipment');
      if (invoice.shipment.status === 'CANCELLED') {
        throw new ConflictException('The shipment was cancelled');
      }
      const invoiceDate = fromDbDate(invoice.invoiceDate);
      const year = invoiceDate.slice(0, 4);
      const number = formatDocumentNumber(
        'INV',
        await nextSequenceValue(tx, 'INVOICE', year),
        year,
      );
      const totalUsd = toUsd(invoice.total, invoice.fxRate, invoice.currency);
      const { entry, receivableAccountId } = await this.autoJournal.customerInvoiceApproved(
        tx,
        { ...invoice, shipmentId: invoice.shipmentId, number, totalUsd },
        user.id,
      );
      await tx.customerInvoice.update({
        where: { id },
        data: {
          status: 'APPROVED',
          number,
          totalUsd,
          journalEntryId: entry.id,
          receivableAccountId,
          approvedAt: new Date(),
          approvedById: user.id,
        },
      });
    });
    return this.get(user, existing.id);
  }

  /** A draft is cancelled with a reason. An approved invoice needs a credit note instead. */
  async cancel(user: AuthUser, id: string, reason: string): Promise<CustomerInvoiceDto> {
    const existing = await this.findScoped(user, id);
    if (existing.status !== 'DRAFT') {
      throw new ConflictException('An approved invoice is corrected by a credit note');
    }
    await this.prisma.$transaction(async (tx) => {
      await lockStatus(tx, id, 'DRAFT');
      await tx.customerInvoice.update({
        where: { id },
        data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date() },
      });
    });
    return this.get(user, id);
  }

  private async findScoped(user: AuthUser, id: string): Promise<InvoiceWithDetails> {
    const invoice = await this.prisma.customerInvoice.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }
}

/** Row lock, then 409 unless the invoice still has the expected status. */
async function lockStatus(tx: Tx, id: string, status: InvoiceStatus): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "customer_invoices" WHERE "id" = ${id}::uuid FOR UPDATE`;
  if (rows[0]?.status !== status) {
    throw new ConflictException('The invoice was changed by someone else; reload it');
  }
}

function addDays(date: string, days: number): string {
  const d = toDbDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDbDate(d);
}

/** UNPAID, PARTIAL or PAID by what payments and credit notes settled together. */
export function paymentStatus(
  invoice: Pick<CustomerInvoice, 'total' | 'paidAmount' | 'creditedAmount'>,
): PaymentStatus {
  const settled = invoice.paidAmount.plus(invoice.creditedAmount);
  if (settled.isZero()) return 'UNPAID';
  return settled.gte(invoice.total) ? 'PAID' : 'PARTIAL';
}

function balance(invoice: {
  total: Decimal;
  paidAmount: Decimal;
  creditedAmount: Decimal;
}): Decimal {
  return invoice.total.minus(invoice.paidAmount).minus(invoice.creditedAmount);
}

function toSummary(i: InvoiceWithDetails): CustomerInvoiceSummaryDto {
  return {
    id: i.id,
    number: i.number,
    branchId: i.branchId,
    customerId: i.customerId,
    customerName: i.customer.name,
    shipmentId: i.shipmentId,
    shipmentNumber: i.shipment?.number ?? null,
    isOpening: i.isOpening,
    reference: i.reference,
    currency: i.currency,
    invoiceDate: fromDbDate(i.invoiceDate),
    dueDate: fromDbDate(i.dueDate),
    status: i.status,
    total: i.total.toFixed(),
    paidAmount: i.paidAmount.toFixed(),
    creditedAmount: i.creditedAmount.toFixed(),
    balance: balance(i).toFixed(),
    paymentStatus: paymentStatus(i),
  };
}

function toDto(i: InvoiceWithDetails, user: AuthUser): CustomerInvoiceDto {
  const isDraft = i.status === 'DRAFT';
  return {
    ...toSummary(i),
    fxRate: i.fxRate.toFixed(),
    totalUsd: i.totalUsd.toFixed(),
    notes: i.notes,
    lines: i.lines.map((l) => ({
      lineNo: l.lineNo,
      chargeTypeCode: l.chargeTypeCode,
      description: l.description,
      quantity: l.quantity.toFixed(),
      unitPrice: l.unitPrice.toFixed(),
      lineTotal: l.lineTotal.toFixed(),
    })),
    payments: i.allocations.map((a) => ({
      receiptId: a.receipt.id,
      receiptNumber: a.receipt.number,
      receiptDate: fromDbDate(a.receipt.receiptDate),
      amount: a.amount.toFixed(),
      cancelled: a.receipt.status === 'CANCELLED',
    })),
    creditNotes: i.creditNotes.map((c) => ({
      creditNoteId: c.id,
      number: c.number,
      creditDate: fromDbDate(c.creditDate),
      amount: c.amount.toFixed(),
      status: c.status,
    })),
    journalEntryId: i.journalEntryId,
    journalEntryNumber: i.journalEntry?.number ?? null,
    approvedAt: i.approvedAt?.toISOString() ?? null,
    cancelReason: i.cancelReason,
    actions: {
      canEdit: isDraft && user.permissions.has('customer_invoices:update'),
      canApprove: isDraft && user.permissions.has('customer_invoices:approve'),
      canCancel: isDraft && user.permissions.has('customer_invoices:cancel'),
      canCreditNote:
        i.status === 'APPROVED' && balance(i).gt(0) && user.permissions.has('credit_notes:create'),
    },
  };
}
