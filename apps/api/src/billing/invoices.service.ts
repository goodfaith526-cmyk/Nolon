import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  BookingService,
  CustomerInvoiceDto,
  CustomerInvoiceInput,
  DecimalString,
  InvoiceSuggestRequest,
  InvoiceSuggestionCurrencySource,
  InvoiceSuggestionDto,
  InvoiceSuggestionLineUse,
  InvoiceSuggestionUnresolved,
  PriceSource,
  RateUnit,
  CustomerInvoiceSummaryDto,
  InvoiceStatus,
  OpeningCustomerItemRequest,
  Page,
  PaymentStatus,
  ReceiptOpenInvoiceDto,
  ShipmentInvoiceRefDto,
  UpdateCustomerInvoiceRequest,
} from '@nolon/shared';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import { toUsd } from '../accounting/journal-math.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope, reportBranchIds } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import { beforeLocalToday, branchZones, dateRange } from '../common/list-filters.js';
import { uuidList } from '../common/report-sql.js';
import {
  type Decimal,
  dec,
  requestedRate,
  roundMoney,
  sameRequestedRate,
  toDecimalString,
  toDecimalStringOrNull,
} from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { codedRefusal, fieldRefusal, fieldRefusals, type PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { type CustomerInvoice, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import { RatesService } from '../rates/rates.service.js';
import {
  type LiveShipmentInvoices,
  type ShipmentInvoicesHandler,
  ShipmentInvoicesRegistry,
} from '../shipments/shipment-invoices.registry.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { CommissionTriggers } from '../shipments/commission-triggers.registry.js';
import { AccountsService } from '../accounting/accounts.service.js';
import type { CommissionInvoice } from '../commissions/commission-math.js';
import { computeInvoiceAmounts } from './invoice-math.js';
import { isLiveInvoice } from './live-invoice.js';
import {
  type SuggestionSource,
  invoiceCurrency,
  quotationDrift,
  quotedLine,
  ratedLine,
  ratedPrice,
  shipmentPriceCategory,
  suggestionFingerprint,
  systemPriceGives,
  unitQuantity,
} from './invoice-suggestion.js';

export interface InvoiceFilters extends PageQuery {
  status?: InvoiceStatus;
  customerId?: string;
  shipmentId?: string;
  /** Approved invoices with a balance left. */
  openOnly?: boolean;
  /** Approved invoices with a balance left, due before today in their branch's time zone. */
  overdue?: boolean;
  /** By what payments and credit notes settled (as `paymentStatus` in the summary). */
  paymentStatus?: PaymentStatus;
  /** One of the user's branches (403 otherwise); else all of them. */
  branchId?: string;
  /** Invoice date from / to, both included. */
  from?: string;
  to?: string;
}

type Tx = Prisma.TransactionClient;

/** A draft invoice checked by prepareForShipment, ready for insertInTx. */
export interface PreparedInvoice {
  branchId: string;
  customerId: string;
  shipmentId: string;
  currency: string;
  fxRate: Decimal;
  invoiceDate: string;
  dueDate: string;
  notes: string | null;
  lines: {
    chargeTypeCode: string;
    description: string | null;
    quantity: Decimal;
    unitPrice: Decimal;
    lineTotal: Decimal;
    /** Where unitPrice came from: given, or the system price (quotation, rate card). */
    priceSource: PriceSource;
    rateCardId: string | null;
  }[];
  total: Decimal;
}

/** A line of an invoice draft ready to be priced: without a unit price, the system price. */
export interface PriceableInvoiceLine {
  chargeTypeCode: string;
  description?: string | null;
  quantity: DecimalString;
  unitPrice?: DecimalString;
}

/** An invoice draft's values: a line without a unit price takes the system price. */
export type InvoiceDraftValues = Omit<CustomerInvoiceInput, 'fxRate' | 'lines'> & {
  lines: PriceableInvoiceLine[];
};

/** A line of an invoice NOLON derives for a shipment (deriveForShipment). */
export interface DerivedInvoiceLine {
  chargeTypeCode: string;
  description: string | null;
  unit: RateUnit;
  quantity: Decimal | null;
  unitPrice: Decimal | null;
  priceSource: PriceSource;
  rateCardId: string | null;
  service: BookingService | null;
  use: InvoiceSuggestionLineUse;
  /** The unit price is part of the line: created without it, the line is priced otherwise. */
  fillPrice: boolean;
}

/** The invoice NOLON derives for a shipment: the suggestion, and createForShipment's lines. */
export interface InvoiceDerivation {
  shipmentId: string;
  branchId: string;
  customerId: string;
  currency: { code: string; decimalPlaces: number };
  currencySource: InvoiceSuggestionCurrencySource;
  invoiceDate: string;
  dueDate: string;
  lines: DerivedInvoiceLine[];
  unresolved: InvoiceSuggestionUnresolved[];
  fingerprint: string;
}

type BillingSource = Awaited<ReturnType<ShipmentsService['billingSource']>>;
type QuotedPrices = Awaited<ReturnType<QuotationsService['invoiceSource']>>;

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
  applications: {
    include: { receipt: { select: { id: true, number: true } } },
    orderBy: [{ applicationDate: 'asc' }, { createdAt: 'asc' }],
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
export class InvoicesService implements ShipmentInvoicesHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoJournal: AutoJournalService,
    private readonly fxRates: FxRatesService,
    private readonly shipments: ShipmentsService,
    private readonly quotations: QuotationsService,
    private readonly customers: CustomersService,
    private readonly currencies: CurrenciesService,
    private readonly masterData: MasterDataService,
    private readonly rates: RatesService,
    private readonly shipmentInvoices: ShipmentInvoicesRegistry,
    private readonly commissions: CommissionTriggers,
    private readonly accounts: AccountsService,
  ) {}

  onModuleInit(): void {
    this.shipmentInvoices.register(this);
  }

  /** For a shipment's cancellation, under its exclusive row lock: the invoices that still bill it. */
  async liveInvoicesInTx(tx: Tx, shipmentId: string): Promise<LiveShipmentInvoices> {
    const invoices = await tx.customerInvoice.findMany({
      where: { shipmentId, status: { not: 'CANCELLED' } },
      select: { number: true, status: true, total: true, paidAmount: true, creditedAmount: true },
      orderBy: { createdAt: 'asc' },
    });
    const live = invoices.filter(isLiveInvoice);
    return {
      approved: live.flatMap((i) => (i.status === 'APPROVED' && i.number ? [i.number] : [])),
      drafts: live.filter((i) => i.status === 'DRAFT').length,
    };
  }

  /**
   * For a percentage commission (plan 07, 4.2), in the caller's transaction: the shipment's
   * approved invoices (not opening items), each with its lines that are not reimbursable charges
   * and the credit notes approved against it.
   */
  async commissionInvoicesInTx(
    tx: Tx,
    shipmentId: string,
  ): Promise<(CommissionInvoice & { invoiceDate: string })[]> {
    const invoices = await tx.customerInvoice.findMany({
      where: { shipmentId, status: 'APPROVED', isOpening: false },
      include: { lines: { select: { chargeTypeCode: true, lineTotal: true } } },
      orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }],
    });
    const reimbursable = await this.accounts.reimbursableCodes(
      tx,
      invoices.flatMap((i) => i.lines.map((l) => l.chargeTypeCode)),
    );
    return invoices.map((i) => ({
      currency: i.currency,
      fxRate: i.fxRate,
      total: i.total,
      credited: i.creditedAmount,
      commissionable: i.lines
        .filter((l) => !reimbursable.has(l.chargeTypeCode))
        .reduce((sum, l) => sum.plus(l.lineTotal), dec(0)),
      invoiceDate: fromDbDate(i.invoiceDate),
    }));
  }

  async list(user: AuthUser, filters: InvoiceFilters): Promise<Page<CustomerInvoiceSummaryDto>> {
    const branchIds = reportBranchIds(user, filters.branchId);
    const settled: Prisma.CustomerInvoiceWhereInput[] = [];
    if (filters.openOnly || filters.overdue) {
      const open = await this.settlementIds(branchIds, 'OPEN', filters.customerId);
      settled.push({ status: 'APPROVED', id: { in: open } });
    }
    if (filters.overdue) {
      settled.push(beforeLocalToday(await branchZones(this.prisma), 'dueDate'));
    }
    if (filters.paymentStatus === 'UNPAID') {
      settled.push({ paidAmount: 0, creditedAmount: 0 });
    } else if (filters.paymentStatus) {
      const ids = await this.settlementIds(branchIds, filters.paymentStatus, filters.customerId);
      settled.push({ id: { in: ids } });
    }
    const where: Prisma.CustomerInvoiceWhereInput = {
      branchId: { in: branchIds },
      invoiceDate: dateRange(filters.from, filters.to),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.shipmentId ? { shipmentId: filters.shipmentId } : {}),
      ...(filters.q
        ? {
            OR: [
              { number: { contains: filters.q, mode: 'insensitive' } },
              { customer: { name: { contains: filters.q, mode: 'insensitive' } } },
              { shipment: { number: { contains: filters.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
      AND: settled,
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
    return this.withPricingNotice(user, toDto(await this.findScoped(user, id), user));
  }

  /**
   * A draft of a shipment whose quotation no longer prices it (agreedPrices) carries why, so the
   * staff member editing it sees that its prices are the rate cards', not the quotation's (plan
   * 5.2, Codex F139-1).
   */
  private async withPricingNotice(
    user: AuthUser,
    invoice: CustomerInvoiceDto,
  ): Promise<CustomerInvoiceDto> {
    if (invoice.status !== 'DRAFT' || invoice.shipmentId === null) return invoice;
    const { drift } = await this.agreedPrices(
      await this.shipments.billingSource(user, invoice.shipmentId),
    );
    return drift === null
      ? invoice
      : { ...invoice, pricingNotice: { code: drift.code, quotationNumber: drift.number } };
  }

  /**
   * A customer's approved invoices with something left to pay, in `currency` if given, oldest due
   * first: what a receipt for them may settle. The customer must be visible to the user.
   */
  async openForCustomer(
    user: AuthUser,
    customerId: string,
    currency: string | undefined,
    limit: number,
  ): Promise<ReceiptOpenInvoiceDto[]> {
    const customer = await this.customers.requireCustomer(user, customerId);
    const ids = await this.settlementIds(
      reportBranchIds(user, customer.branchId),
      'OPEN',
      customer.id,
    );
    const invoices = await this.prisma.customerInvoice.findMany({
      where: { id: { in: ids }, ...(currency ? { currency } : {}) },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return invoices.map((i) => ({
      id: i.id,
      number: i.number,
      currency: i.currency,
      total: toDecimalString(i.total),
      outstanding: toDecimalString(i.total.minus(i.paidAmount).minus(i.creditedAmount)),
      invoiceDate: fromDbDate(i.invoiceDate),
      dueDate: fromDbDate(i.dueDate),
    }));
  }

  /**
   * Invoices of these branches by what payments and credit notes settled together: OPEN is approved
   * with a balance left; PARTIAL and PAID as `paymentStatus` (a sum of two columns, so in SQL).
   */
  private async settlementIds(
    branchIds: readonly string[],
    settlement: 'OPEN' | 'PARTIAL' | 'PAID',
    customerId?: string,
  ): Promise<string[]> {
    if (branchIds.length === 0) return [];
    const settled = Prisma.sql`("paid_amount" + "credited_amount")`;
    const condition = {
      OPEN: Prisma.sql`"status" = 'APPROVED' AND ${settled} < "total"`,
      PARTIAL: Prisma.sql`${settled} > 0 AND ${settled} < "total"`,
      PAID: Prisma.sql`${settled} <> 0 AND ${settled} >= "total"`,
    }[settlement];
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "customer_invoices"
      WHERE ${condition}
        AND "branch_id" IN ${uuidList(branchIds)}
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
            requestedFxRate: requestedRate(input.fxRate),
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
    const entry = existing.journalEntryId
      ? await this.prisma.journalEntry.findUnique({
          where: { id: existing.journalEntryId },
          select: { entryDate: true },
        })
      : null;
    const same =
      existing.isOpening &&
      entry !== null &&
      existing.customerId === input.customerId &&
      existing.createdById === user.id &&
      existing.currency === input.currency &&
      sameRequestedRate(existing.requestedFxRate, input.fxRate) &&
      fromDbDate(entry.entryDate) === input.entryDate &&
      fromDbDate(existing.invoiceDate) === input.invoiceDate &&
      fromDbDate(existing.dueDate) === input.dueDate &&
      existing.reference === input.reference &&
      existing.total.eq(dec(input.amount));
    if (!same) {
      throw new ConflictException('This request id was already used: send a new id');
    }
    return this.get(user, existing.id);
  }

  /**
   * What NOLON would put on an invoice for a shipment (POST /invoice-drafts/suggest), read-only:
   * deriveForShipment for the currency and invoice date asked for, else NOLON's defaults.
   */
  async suggestForShipment(
    user: AuthUser,
    input: InvoiceSuggestRequest,
  ): Promise<InvoiceSuggestionDto> {
    const derived = await this.deriveForShipment(user, input.shipmentId, input);
    return {
      shipmentId: derived.shipmentId,
      branchId: derived.branchId,
      currency: derived.currency.code,
      currencySource: derived.currencySource,
      invoiceDate: derived.invoiceDate,
      dueDate: derived.dueDate,
      lines: derived.lines.map((l) => ({
        chargeTypeCode: l.chargeTypeCode,
        description: l.description,
        unit: l.unit,
        quantity: toDecimalStringOrNull(l.quantity),
        unitPrice: toDecimalStringOrNull(l.unitPrice),
        priceSource: l.priceSource,
        rateCardId: l.rateCardId,
        service: l.service,
        use: l.use,
        fillPrice: l.fillPrice,
      })),
      unresolved: derived.unresolved,
      fingerprint: derived.fingerprint,
      shipmentInvoices: await this.invoicesOfShipment(derived.shipmentId),
    };
  }

  /**
   * The shipment's invoices that are not cancelled, oldest first: what a person confirms having
   * seen before another invoice bills the shipment (Q3). The caller has checked access to it.
   */
  async invoicesOfShipment(
    shipmentId: string,
    tx: Tx | PrismaService = this.prisma,
  ): Promise<ShipmentInvoiceRefDto[]> {
    return tx.customerInvoice.findMany({
      where: { shipmentId, status: { not: 'CANCELLED' } },
      select: { id: true, number: true, status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * A draft invoice for a shipment, prefilled as deriveForShipment derives it with NOLON's
   * defaults: dated today in the branch, due after the customer's payment terms, with the lines
   * it fills (the quotation's; a rate card's only for a charge of a service the shipment has).
   */
  async createForShipment(
    user: AuthUser,
    shipmentId: string,
    acknowledgedInvoiceIds: readonly string[] = [],
  ): Promise<CustomerInvoiceDto> {
    const derived = await this.deriveForShipment(user, shipmentId, {});
    const { currency, invoiceDate } = derived;
    const fxRate = await this.fxRates.resolve(currency.code, invoiceDate);
    const lines = derived.lines.flatMap((l) =>
      l.use === 'FILL' && l.quantity !== null && l.unitPrice !== null
        ? [{ ...l, quantity: l.quantity, unitPrice: l.unitPrice }]
        : [],
    );
    const { lineTotals, total } = computeInvoiceAmounts(lines, currency.decimalPlaces);
    const created = await this.prisma.$transaction(async (tx) => {
      await this.lockForNewInvoice(tx, derived.shipmentId, acknowledgedInvoiceIds);
      return tx.customerInvoice.create({
        data: {
          branchId: derived.branchId,
          customerId: derived.customerId,
          shipmentId: derived.shipmentId,
          currency: currency.code,
          fxRate,
          invoiceDate: toDbDate(invoiceDate),
          dueDate: toDbDate(derived.dueDate),
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
    });
    return this.withPricingNotice(user, toDto(created, user));
  }

  /**
   * The invoice NOLON derives for a shipment (fix D), one set of rules for the suggestion and for
   * createForShipment; nothing is written. The shipment as it is billed (the owning branch's,
   * not cancelled, its customer visible). The currency: the one asked for, else the quotation's,
   * the customer's preferred, the branch default. Dated `invoiceDate` (default today in the
   * branch), due after the customer's payment terms. The lines: the quotation's, priced as
   * agreed (in the quotation's currency only); with no quotation, or one that no longer prices
   * the shipment (its route, mode or categories changed: agreedPrices, said in `unresolved`), one
   * per charge type with exactly one approved rate card matching the shipment (its one price
   * category, if any) in that currency, its quantity from the unit where exact. A rate card line is filled only for a charge whose service the shipment
   * has: a matching tariff is not proof the charge happened; otherwise it is offered.
   */
  async deriveForShipment(
    user: AuthUser,
    shipmentId: string,
    asked: { currency?: string; invoiceDate?: string },
  ): Promise<InvoiceDerivation> {
    const shipment = await this.shipments.billingSource(user, shipmentId);
    if (shipment.status === 'CANCELLED') {
      throw new ConflictException('A cancelled shipment is not invoiced');
    }
    const customer = await this.customers.requireCustomer(user, shipment.customerId);
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: shipment.branchId } });
    const { quotation, drift } = await this.agreedPrices(shipment);
    const chosen = invoiceCurrency({
      requested: asked.currency ?? null,
      quotation: quotation?.currency ?? null,
      customer: customer.preferredCurrency,
      branch: branch.defaultCurrency,
    });
    const currency = await this.currencies.requireActive(chosen.code);
    const invoiceDate = asked.invoiceDate ?? todayIn(branch.timezone);
    const unresolved: InvoiceSuggestionUnresolved[] = [];
    if (drift !== null) {
      unresolved.push({
        path: 'lines',
        code: drift.code,
        message:
          drift.code === 'QUOTATION_ROUTE_CHANGED'
            ? `The shipment's route or mode is no longer quotation ${drift.number}'s: its ` +
              'prices are not used, the lines come from the rate cards'
            : `The shipment's price categories are no longer quotation ${drift.number}'s: its ` +
              'prices are not used, the lines come from the rate cards',
      });
    }
    const lines: DerivedInvoiceLine[] = [];
    let source: SuggestionSource;
    if (quotation !== null) {
      source = { quotation: { id: quotation.id, updatedAt: quotation.updatedAt } };
      const charges = await this.masterData.activeChargeTypes(
        quotation.lines.map((l) => l.chargeTypeCode),
      );
      for (const l of quotation.lines) {
        const path = `lines.${lines.length}`;
        const line = {
          chargeTypeCode: l.chargeTypeCode,
          description: l.description,
          unit: l.unit,
          priceSource: 'QUOTATION' as const,
          rateCardId: null,
          service: charges.get(l.chargeTypeCode)?.service ?? null,
        };
        if (quotation.currency !== currency.code) {
          unresolved.push({
            path: `${path}.unitPrice`,
            code: 'QUOTED_PRICE_OTHER_CURRENCY',
            message:
              `The shipment's quotation prices ${l.chargeTypeCode} in ${quotation.currency}: ` +
              `invoice in ${quotation.currency}, or enter the price`,
          });
          lines.push({
            ...line,
            quantity: l.quantity,
            unitPrice: null,
            use: 'OFFER',
            fillPrice: false,
          });
        } else {
          lines.push({
            ...line,
            ...quotedLine(l, currency.decimalPlaces),
            use: 'FILL',
            fillPrice: false,
          });
        }
      }
    } else {
      const rates = await this.rates.systemRates({
        branchId: shipment.branchId,
        onDate: invoiceDate,
        currency: currency.code,
        originLocationId: shipment.originLocationId,
        destinationLocationId: shipment.destinationLocationId,
        mode: shipment.mode,
        loadType: shipment.loadType,
        cargoType: shipment.cargoType,
        priceCategoryCode: shipmentPriceCategory(shipment.priceCategoryCodes),
      });
      source = { rateCards: rates.map((r) => ({ id: r.id, updatedAt: r.updatedAt })) };
      const charges = await this.masterData.activeChargeTypes(rates.map((r) => r.chargeTypeCode));
      const codes = [...new Set(rates.map((r) => r.chargeTypeCode))].sort();
      for (const chargeTypeCode of codes) {
        const charge = charges.get(chargeTypeCode);
        if (!charge) continue;
        const [rate, ...more] = rates.filter((r) => r.chargeTypeCode === chargeTypeCode);
        if (!rate) continue;
        if (more.length > 0) {
          unresolved.push({
            path: 'lines',
            code: 'RATE_SEVERAL',
            message:
              `${more.length + 1} approved rate cards match ${chargeTypeCode} ` +
              '(container type or unit differ): no line is suggested for it',
          });
          continue;
        }
        const path = `lines.${lines.length}`;
        const quantity = unitQuantity(
          rate.unit,
          shipment.items,
          rate.containerTypeCode,
          shipment.cargoType,
        );
        if (quantity === null) {
          unresolved.push({
            path: `${path}.quantity`,
            code: 'QUANTITY_UNKNOWN',
            message:
              `The shipment's cargo does not give an exact ${rate.unit} quantity for ` +
              `${chargeTypeCode} (a measure is missing or ambiguous): enter the quantity`,
          });
        }
        const service = charge.service;
        const covered = service !== null && shipment.services.includes(service);
        if (service === null) {
          unresolved.push({
            path,
            code: 'SERVICE_NOT_MAPPED',
            message:
              `${chargeTypeCode} belongs to no service, so a rate card does not show it was ` +
              'charged: add it only if it applies',
          });
        } else if (!covered) {
          unresolved.push({
            path,
            code: 'SERVICE_NOT_ON_SHIPMENT',
            message:
              `${chargeTypeCode} belongs to ${service}, which the shipment does not have: add ` +
              'it only if it applies',
          });
        }
        const rated = ratedLine(rate, quantity, currency.decimalPlaces);
        // A minimum the system price would not give (0.25 kg at 100/kg, minimum 60: 1 × 60, while
        // 1 unit with no price is 1 × 100) is filled with its price, marked so a caller sends
        // the price with the line (owner 2026-10-18; Codex N89-1, N89-3).
        const fillPrice = !systemPriceGives(rate, rated, currency.decimalPlaces);
        lines.push({
          chargeTypeCode,
          description: null,
          unit: rate.unit,
          ...rated,
          priceSource: 'RATE_CARD',
          rateCardId: rate.id,
          service,
          use: covered && quantity !== null ? 'FILL' : 'OFFER',
          fillPrice,
        });
      }
    }
    const dueDate = addDays(invoiceDate, customer.paymentTermsDays);
    return {
      shipmentId: shipment.id,
      branchId: shipment.branchId,
      customerId: shipment.customerId,
      currency,
      currencySource: chosen.source,
      invoiceDate,
      dueDate,
      lines,
      unresolved,
      fingerprint: suggestionFingerprint({
        shipmentId: shipment.id,
        branchId: shipment.branchId,
        currency: currency.code,
        currencySource: chosen.source,
        pricingDate: invoiceDate,
        dueDate,
        source,
        lines,
        unresolved,
      }),
    };
  }

  /**
   * The rate cards the shipment is priced from, for its expected margin (plan 6.2): its
   * quotation's lines while the quotation still prices it (agreedPrices; a line typed by hand
   * names no card), else the rate card lines its invoice suggestion fills (deriveForShipment, in
   * its default currency): a tariff it only offers is not proof the charge applies. Each with the
   * quantity it is priced at (null when the cargo does not give it exactly).
   */
  async pricedFrom(
    user: AuthUser,
    shipmentId: string,
  ): Promise<{
    source: 'QUOTATION' | 'RATE_CARDS';
    lines: { chargeTypeCode: string; rateCardId: string | null; quantity: Decimal | null }[];
  }> {
    const shipment = await this.shipments.billingSource(user, shipmentId);
    const { quotation } = await this.agreedPrices(shipment);
    if (quotation !== null) {
      return {
        source: 'QUOTATION',
        lines: quotation.lines.map((l) => ({
          chargeTypeCode: l.chargeTypeCode,
          rateCardId: l.rateCardId,
          quantity: l.quantity,
        })),
      };
    }
    const derived = await this.deriveForShipment(user, shipmentId, {});
    const filled = derived.lines.filter((l) => l.use === 'FILL');
    // The cargo's own quantity, not the invoice line's: below a minimum charge the line is 1 × the
    // minimum, while the costs are per unit of cargo (Codex F145-2). The margin applies the
    // minimum to the price itself.
    const rates = new Map(
      (
        await this.prisma.rateCard.findMany({
          where: { id: { in: filled.flatMap((l) => (l.rateCardId ? [l.rateCardId] : [])) } },
          select: { id: true, unit: true, containerTypeCode: true },
        })
      ).map((r) => [r.id, r]),
    );
    return {
      source: 'RATE_CARDS',
      lines: filled.map((l) => {
        const rate = l.rateCardId ? rates.get(l.rateCardId) : undefined;
        return {
          chargeTypeCode: l.chargeTypeCode,
          rateCardId: l.rateCardId,
          quantity: rate
            ? unitQuantity(rate.unit, shipment.items, rate.containerTypeCode, shipment.cargoType)
            : null,
        };
      }),
    };
  }

  /**
   * The checks of a draft invoice for a shipment with the given values (an assistant's invoice
   * draft), as update() checks them, without writing; insertInTx then records it. The fx rate is
   * the rate table's for the invoice date. A line without a unit price takes the system price
   * (systemPrice), so the result says where each price came from. With `everyLine` (the
   * pre-check), every line's refusal is collected and refused together (fieldRefusals), not only
   * the first.
   */
  async prepareForShipment(
    user: AuthUser,
    shipmentId: string,
    input: InvoiceDraftValues,
    options: { everyLine?: boolean } = {},
  ): Promise<PreparedInvoice> {
    const shipment = await this.shipments.billingSource(user, shipmentId);
    if (shipment.status === 'CANCELLED') {
      throw new ConflictException('A cancelled shipment is not invoiced');
    }
    await this.customers.requireCustomer(user, shipment.customerId);
    if (input.dueDate < input.invoiceDate) {
      throw new BadRequestException('The due date is before the invoice date');
    }
    const currency = await this.currencies.requireActive(input.currency);
    const refused: BadRequestException[] = [];
    const collect = (error: unknown): void => {
      if (!options.everyLine || !(error instanceof BadRequestException)) throw error;
      refused.push(error);
    };
    const unknownCharge = new Set<number>();
    for (const [index, line] of input.lines.entries()) {
      try {
        await this.masterData.requireChargeType(line.chargeTypeCode);
      } catch (error) {
        collect(error);
        unknownCharge.add(index);
      }
    }
    const fxRate = await this.fxRates.resolve(currency.code, input.invoiceDate);
    const quoted = input.lines.some((l) => l.unitPrice === undefined)
      ? (await this.agreedPrices(shipment)).quotation
      : null;
    const lines = [];
    for (const [index, l] of input.lines.entries()) {
      if (unknownCharge.has(index)) continue;
      const quantity = dec(l.quantity);
      let price: { unitPrice: Decimal; priceSource: PriceSource; rateCardId: string | null };
      try {
        price =
          l.unitPrice === undefined
            ? await this.systemPrice(shipment, quoted, {
                path: `lines.${index}`,
                chargeTypeCode: l.chargeTypeCode,
                quantity,
                currency: currency.code,
                decimalPlaces: currency.decimalPlaces,
                invoiceDate: input.invoiceDate,
              })
            : { unitPrice: dec(l.unitPrice), priceSource: 'TYPED', rateCardId: null };
      } catch (error) {
        collect(error);
        continue;
      }
      lines.push({
        chargeTypeCode: l.chargeTypeCode,
        description: l.description ?? null,
        quantity,
        ...price,
      });
    }
    if (refused.length > 0) throw fieldRefusals(refused);
    const { lineTotals, total } = computeInvoiceAmounts(lines, currency.decimalPlaces);
    return {
      branchId: shipment.branchId,
      customerId: shipment.customerId,
      shipmentId: shipment.id,
      currency: currency.code,
      fxRate,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      notes: input.notes ?? null,
      lines: lines.map((l, i) => ({ ...l, lineTotal: lineTotals[i] ?? dec(0) })),
      total,
    };
  }

  /**
   * The checks of prepareForShipment on the values an invoice draft holds so far (a draft is
   * saved with missing values): the shipment as it is billed (the owning branch's, not
   * cancelled, its customer visible) when named, the dates in order when both are given, the
   * currency when given, each line's charge when given. Prices wait for prepareForShipment. The
   * shipment's branch and customer, or null with no shipment. Nothing is written.
   */
  async checkPresentForShipment(
    user: AuthUser,
    shipmentId: string | null,
    input: {
      currency?: string | null;
      invoiceDate?: string | null;
      dueDate?: string | null;
      lines: readonly { chargeTypeCode?: string | null }[];
    },
  ): Promise<{ branchId: string | null; customerId: string | null; currency: string | null }> {
    let shipment: BillingSource | null = null;
    if (shipmentId !== null) {
      shipment = await this.shipments.billingSource(user, shipmentId);
      if (shipment.status === 'CANCELLED') {
        throw new ConflictException('A cancelled shipment is not invoiced');
      }
      await this.customers.requireCustomer(user, shipment.customerId);
    }
    if (input.dueDate && input.invoiceDate && input.dueDate < input.invoiceDate) {
      throw new BadRequestException('The due date is before the invoice date');
    }
    const currency = input.currency ? await this.currencies.requireActive(input.currency) : null;
    for (const line of input.lines) {
      if (line.chargeTypeCode) await this.masterData.requireChargeType(line.chargeTypeCode);
    }
    return {
      branchId: shipment?.branchId ?? null,
      customerId: shipment?.customerId ?? null,
      currency: currency?.code ?? null,
    };
  }

  /**
   * The shipment's quotation as the source of its agreed prices (plan 5.2): null with no
   * quotation, or when the shipment no longer is what it priced (quotationDrift), with the reason
   * then, so the invoice is priced from the rate cards and says why.
   */
  private async agreedPrices(shipment: BillingSource): Promise<{
    quotation: QuotedPrices;
    drift: {
      code: 'QUOTATION_ROUTE_CHANGED' | 'QUOTATION_CATEGORY_CHANGED';
      number: string;
    } | null;
  }> {
    const quotation = shipment.quotationId
      ? await this.quotations.invoiceSource(shipment.quotationId)
      : null;
    if (quotation === null) return { quotation: null, drift: null };
    const drift = quotationDrift(quotation, shipment);
    if (drift === null) return { quotation, drift: null };
    return {
      quotation: null,
      drift: {
        code: drift === 'ROUTE' ? 'QUOTATION_ROUTE_CHANGED' : 'QUOTATION_CATEGORY_CHANGED',
        number: quotation.number,
      },
    };
  }

  /**
   * The system price of an invoice line: the agreed price first, from the shipment's quotation
   * line for this charge (in the quotation's currency only, and only while the quotation still
   * prices the shipment: agreedPrices); a charge the quotation does not price takes the approved
   * rate card that matches the shipment (its one price category, if any), the charge and the
   * invoice date. Where a minimum or a discount makes the amount differ from quantity × price, the agreed
   * amount is invoiced as one unit, as createForShipment does. Refused, under the line's field,
   * whenever the price is not one clear value: the staff member then enters it.
   */
  private async systemPrice(
    shipment: BillingSource,
    quoted: QuotedPrices,
    line: {
      path: string;
      chargeTypeCode: string;
      quantity: Decimal;
      currency: string;
      decimalPlaces: number;
      invoiceDate: string;
    },
  ): Promise<{ unitPrice: Decimal; priceSource: PriceSource; rateCardId: string | null }> {
    const { path, chargeTypeCode, quantity, currency, decimalPlaces } = line;
    const asOneUnit = (amount: Decimal, why: string): Decimal => {
      if (quantity.eq(1)) return amount;
      throw fieldRefusal(
        'PRICE_AS_ONE_UNIT',
        `The ${chargeTypeCode} amount is ${amount.toFixed(decimalPlaces)} ${currency} ` +
          `(${why}): invoice it as quantity 1, or enter the price`,
        [`${path}.quantity`],
      );
    };
    const quotedLines = quoted?.lines.filter((q) => q.chargeTypeCode === chargeTypeCode) ?? [];
    const [agreed, ...more] = quotedLines;
    if (quoted !== null && agreed !== undefined) {
      if (quoted.currency !== currency) {
        throw fieldRefusal(
          'QUOTED_PRICE_OTHER_CURRENCY',
          `The shipment's quotation prices ${chargeTypeCode} in ${quoted.currency}: invoice in ` +
            `${quoted.currency}, or enter the price`,
          ['currency', `${path}.unitPrice`],
        );
      }
      if (more.length > 0) {
        throw fieldRefusal(
          'QUOTED_PRICE_SEVERAL',
          `The shipment's quotation has ${quotedLines.length} ${chargeTypeCode} lines: enter ` +
            'the price',
          [`${path}.unitPrice`],
        );
      }
      const exact = roundMoney(agreed.quantity.times(agreed.unitPrice), decimalPlaces);
      return {
        unitPrice: exact.eq(agreed.lineTotal)
          ? agreed.unitPrice
          : asOneUnit(agreed.lineTotal, "the quotation's minimum or discount"),
        priceSource: 'QUOTATION',
        rateCardId: null,
      };
    }
    const { rate } = await this.rates.systemRate(
      {
        branchId: shipment.branchId,
        onDate: line.invoiceDate,
        currency,
        originLocationId: shipment.originLocationId,
        destinationLocationId: shipment.destinationLocationId,
        mode: shipment.mode,
        loadType: shipment.loadType,
        cargoType: shipment.cargoType,
        priceCategoryCode: shipmentPriceCategory(shipment.priceCategoryCodes),
        chargeTypeCode,
      },
      { noMatch: [`${path}.unitPrice`], several: [`${path}.unitPrice`] },
    );
    const priced = ratedPrice(rate, quantity, decimalPlaces);
    return {
      unitPrice:
        'oneUnit' in priced
          ? asOneUnit(priced.oneUnit, "the rate card's minimum charge")
          : priced.unitPrice,
      priceSource: 'RATE_CARD',
      rateCardId: rate.id,
    };
  }

  /** Records a prepared DRAFT invoice inside the caller's transaction; posts nothing. */
  async insertInTx(
    tx: Tx,
    user: AuthUser,
    prepared: PreparedInvoice,
    acknowledged: { invoiceIds: readonly string[]; listed: boolean },
  ): Promise<string> {
    await this.lockForNewInvoice(
      tx,
      prepared.shipmentId,
      acknowledged.invoiceIds,
      acknowledged.listed,
    );
    const created = await tx.customerInvoice.create({
      data: {
        branchId: prepared.branchId,
        customerId: prepared.customerId,
        shipmentId: prepared.shipmentId,
        currency: prepared.currency,
        fxRate: prepared.fxRate,
        invoiceDate: toDbDate(prepared.invoiceDate),
        dueDate: toDbDate(prepared.dueDate),
        notes: prepared.notes,
        total: prepared.total,
        totalUsd: toUsd(prepared.total, prepared.fxRate, prepared.currency),
        createdById: user.id,
        lines: {
          create: prepared.lines.map((l, index) => ({
            lineNo: index + 1,
            chargeTypeCode: l.chargeTypeCode,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
          })),
        },
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Drafts only; the lines are replaced as a whole. */
  async update(
    user: AuthUser,
    id: string,
    input: UpdateCustomerInvoiceRequest,
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
      // The line prices are amounts in the invoice's currency: a new currency keeps none of them
      // as they stand (3,670 AED is not 3,670 USD). The request says it priced the lines anew.
      const { currency: current } = await tx.customerInvoice.findUniqueOrThrow({
        where: { id },
        select: { currency: true },
      });
      if (current !== currency.code && input.repriced !== true) {
        throw fieldRefusal(
          'INVOICE_CURRENCY_REPRICE',
          `The invoice is in ${current}: to invoice in ${currency.code}, enter every price in ${currency.code} (repriced)`,
          ['currency'],
          { from: current, to: currency.code },
        );
      }
      await tx.customerInvoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.customerInvoice.update({
        where: { id },
        data: {
          currency: currency.code,
          fxRate,
          requestedFxRate: requestedRate(input.fxRate),
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
    // An approved invoice (an opening item has no shipment at all) is not approved again; the
    // status is checked again under the invoice's lock below.
    if (existing.status !== 'DRAFT')
      throw new ConflictException('Only a draft invoice is approved');
    if (!existing.shipmentId) throw new Error('A draft bills a shipment');
    const shipmentId = existing.shipmentId;
    await this.prisma.$transaction(async (tx) => {
      // The shipment first, then the invoice: the order a shipment's cancellation takes them in.
      await this.lockBilledShipment(tx, shipmentId);
      await lockStatus(tx, id, 'DRAFT');
      await this.commissions.lockInTx(tx, shipmentId);
      const invoice = await tx.customerInvoice.findUniqueOrThrow({
        where: { id },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      });
      if (invoice.lines.length === 0 || !invoice.total.gt(0)) {
        throw new BadRequestException('An invoice needs at least one line with an amount');
      }
      if (invoice.shipmentId !== shipmentId) throw new Error('A draft keeps its shipment');
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
        { ...invoice, shipmentId, number, totalUsd },
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
      // The INVOICED event, and a percentage's base (plan 07, 4.2), on the invoice's date.
      await this.commissions.shipmentChangedInTx(
        tx,
        user,
        shipmentId,
        'INVOICE_APPROVED',
        invoiceDate,
      );
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

  /**
   * Share-locks the shipment an invoice bills, inside the caller's transaction, and refuses a
   * cancelled one (409). A shipment's cancellation takes this lock exclusively and refuses while an
   * invoice still bills it, so an invoice cannot be created or approved under it as it goes.
   */
  /**
   * Before another invoice bills a shipment (Q3): locks the shipment exclusively, so two new
   * invoices queue behind each other, refuses a cancelled one, and refuses (409) unless
   * `acknowledged` names exactly the shipment's invoices that are not cancelled, as the person saw
   * them. `listed` is false where the invoices could not be shown to the person (the assistant's
   * chat): there, a shipment with invoices sends the approval to NOLON's review screen.
   */
  private async lockForNewInvoice(
    tx: Tx,
    shipmentId: string,
    acknowledged: readonly string[],
    listed = true,
  ): Promise<void> {
    const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
    if (status === 'CANCELLED') throw new ConflictException('The shipment was cancelled');
    const current = await this.invoicesOfShipment(shipmentId, tx);
    const seen = new Set(acknowledged);
    if (listed && current.length === seen.size && current.every((i) => seen.has(i.id))) return;
    if (current.length === 0 && seen.size === 0) return;
    const { number } = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { number: true },
    });
    const approved = current.flatMap((i) => (i.number ? [i.number] : [])).join(', ') || '—';
    const drafts = String(current.filter((i) => i.status === 'DRAFT').length);
    throw codedRefusal(
      HttpStatus.CONFLICT,
      listed ? 'SHIPMENT_ALREADY_INVOICED' : 'SHIPMENT_ALREADY_INVOICED_REVIEW',
      listed
        ? `Shipment ${number} has invoices other than those acknowledged (approved: ${approved}; drafts: ${drafts}): check them and send their ids to add another invoice`
        : `Shipment ${number} already has invoices (approved: ${approved}; drafts: ${drafts}): approve this draft on its review screen in NOLON`,
      { shipment: number, approved, drafts },
    );
  }

  private async lockBilledShipment(tx: Tx, shipmentId: string): Promise<void> {
    const status = await this.shipments.lockForChildWrite(tx, shipmentId);
    if (status === 'CANCELLED') throw new ConflictException('The shipment was cancelled');
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
    enteredFxRate: toDecimalStringOrNull(i.requestedFxRate),
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
    payments: [
      ...i.allocations.map((a) => ({
        receiptId: a.receipt.id,
        receiptNumber: a.receipt.number,
        receiptDate: fromDbDate(a.receipt.receiptDate),
        amount: a.amount.toFixed(),
        cancelled: a.receipt.status === 'CANCELLED',
        applicationId: null,
      })),
      // A receipt's advance applied later pays the invoice too, from the day it was applied.
      ...i.applications.map((a) => ({
        receiptId: a.receipt.id,
        receiptNumber: a.receipt.number,
        receiptDate: fromDbDate(a.applicationDate),
        amount: a.amount.toFixed(),
        cancelled: a.status === 'REVERSED',
        applicationId: a.id,
      })),
    ],
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
    pricingNotice: null,
    actions: {
      canEdit: isDraft && user.access.has('customer_invoices:update', i.branchId),
      canApprove: isDraft && user.access.has('customer_invoices:approve', i.branchId),
      canCancel: isDraft && user.access.has('customer_invoices:cancel', i.branchId),
      canCreditNote:
        i.status === 'APPROVED' &&
        balance(i).gt(0) &&
        user.access.has('credit_notes:create', i.branchId),
    },
  };
}
