import { Inject, Injectable } from '@nestjs/common';
import {
  CS_STATEMENT_MAX_ROWS,
  type CsInvoiceDto,
  type CsStatementBookingDto,
  type CsStatementDto,
  type CsStatementInvoiceTotalDto,
  type CsStatementRequestDto,
  type CsStatementSection,
} from '@nolon/shared';
import { daysBetween, fromDbDate, isDateString, toDbDate, todayIn } from '../common/dates.js';
import { startOfDayIn, nextDay } from '../common/list-filters.js';
import { type Decimal, toDecimalString } from '../common/money.js';
import { uuidList } from '../common/report-sql.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { PdfService, PdfUnavailableError } from '../pdf/pdf.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { placeSelect, stateOf, storedBotNames } from './booking-requests.service.js';
import { identityError } from './customer-identity-auth.js';
import { trackOf } from './customer-stages.js';
import { CustomerStagesService } from './customer-stages.service.js';
import type { CustomerTokenAuth } from './customer-token.guard.js';
import { CustomerTokensService } from './customer-tokens.service.js';
import { type StatementLang, statementHtml } from './statement-html.js';

/** The company's customer day (plan 14 F206-8), as the customer reports. */
export const STATEMENT_TIMEZONE = 'Africa/Khartoum';
const MAX_DAYS = 366;

/** `date` minus `months` calendar months, the day clamped to the month's last. */
export function monthsBefore(date: string, months: number): string {
  const d = toDbDate(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/**
 * The statement's period (plan 14-2): both optional; `to` defaults to today, `from` to 6 months
 * before `to`. Null when invalid: a bad date, `from` after `to`, more than 366 days, `to` after
 * today.
 */
export function statementPeriod(
  raw: { from?: string; to?: string },
  today: string,
): { from: string; to: string } | null {
  if (raw.from !== undefined && !isDateString(raw.from)) return null;
  if (raw.to !== undefined && !isDateString(raw.to)) return null;
  const to = raw.to ?? today;
  const from = raw.from ?? monthsBefore(to, 6);
  if (from > to || to > today) return null;
  return daysBetween(from, to) + 1 > MAX_DAYS ? null : { from, to };
}

function section<T>(rows: T[], count: number): CsStatementSection<T> {
  return { rows, count, truncated: count > rows.length };
}

interface InvoiceRow {
  number: string;
  shipmentNumber: string | null;
  invoice_date: Date;
  due_date: Date;
  currency: string;
  total: Decimal;
  paid_amount: Decimal;
  credited_amount: Decimal;
  balance: Decimal;
}

interface TotalRow {
  currency: string;
  count: bigint;
  total: Decimal;
  paid: Decimal;
  credited: Decimal;
  balance: Decimal;
}

type Tx = Prisma.TransactionClient;

/**
 * The customer's statement (plan 14-2): the requests the token holder owns, the customer's
 * bookings and (for the customer's own number) invoices, for a period, in the key's branches.
 * One read-only REPEATABLE READ snapshot. Every read is in the access log.
 */
@Injectable()
export class CustomerStatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: CustomerTokensService,
    private readonly stages: CustomerStagesService,
    private readonly pdfs: PdfService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /** GET /cs/me/statement. The raw query is read here so every refusal is logged. */
  async statement(auth: CustomerTokenAuth, query: unknown): Promise<CsStatementDto> {
    const route = 'GET /cs/me/statement';
    await this.requireEnabled(auth, route);
    const raw = await this.readQuery(auth, route, query, ['from', 'to']);
    const dto = await this.build(auth, await this.period(auth, route, raw));
    await this.record(auth, route, 'OK');
    return dto;
  }

  /**
   * GET /cs/me/statement/pdf (plan 14-3): the same checks and data, rendered on request and never
   * stored. Order: switch, query, lang, period, renderer. No renderer: 503 PDF_UNAVAILABLE; a
   * failed or overloaded render: 503 PDF_FAILED. All logged.
   */
  async pdf(auth: CustomerTokenAuth, query: unknown): Promise<{ bytes: Buffer; filename: string }> {
    const route = 'GET /cs/me/statement/pdf';
    await this.requireEnabled(auth, route);
    const raw = await this.readQuery(auth, route, query, ['from', 'to', 'lang']);
    if (raw.lang !== undefined && raw.lang !== 'ar' && raw.lang !== 'en') {
      await this.record(auth, route, 'INVALID_LANG');
      identityError(400, 'INVALID_LANG');
    }
    const period = await this.period(auth, route, raw);
    if (!this.pdfs.configured) {
      await this.record(auth, route, 'PDF_UNAVAILABLE');
      identityError(503, 'PDF_UNAVAILABLE');
    }
    const dto = await this.build(auth, period);
    const lang: StatementLang =
      raw.lang === 'ar' || raw.lang === 'en'
        ? raw.lang
        : (
              await this.prisma.customer.findUnique({
                where: { id: auth.customerId },
                select: { preferredLocale: true },
              })
            )?.preferredLocale === 'en'
          ? 'en'
          : 'ar';
    let bytes: Buffer;
    try {
      bytes = await this.pdfs.render(statementHtml(dto, lang));
    } catch (error) {
      if (!(error instanceof PdfUnavailableError)) throw error;
      const code = error.reason === 'NOT_CONFIGURED' ? 'PDF_UNAVAILABLE' : 'PDF_FAILED';
      await this.record(auth, route, code);
      identityError(503, code);
    }
    await this.record(auth, route, 'OK');
    return {
      bytes,
      filename: `statement-${dto.customer.number}-${dto.period.from}-${dto.period.to}.pdf`,
    };
  }

  private record(auth: CustomerTokenAuth, route: string, outcome: string): Promise<void> {
    return this.tokens.record(auth.client.id, auth.tokenId, auth.customerId, outcome, route);
  }

  private async requireEnabled(auth: CustomerTokenAuth, route: string): Promise<void> {
    if (!this.env.CS_STATEMENT_ENABLED) {
      await this.record(auth, route, 'UNAVAILABLE');
      identityError(503, 'STATEMENT_UNAVAILABLE');
    }
  }

  /**
   * The query as given (F209-2): only the allowed keys, each one string of at most 10 characters.
   * Anything else (unknown key, repeated key, too long) is logged and refused as INVALID_RANGE.
   */
  private async readQuery(
    auth: CustomerTokenAuth,
    route: string,
    query: unknown,
    allowed: readonly string[],
  ): Promise<Record<string, string | undefined>> {
    const out: Record<string, string | undefined> = {};
    let ok = query === undefined || (typeof query === 'object' && query !== null);
    if (ok && query) {
      for (const [key, value] of Object.entries(query)) {
        if (!allowed.includes(key) || typeof value !== 'string' || value.length > 10) {
          ok = false;
          break;
        }
        out[key] = value;
      }
    }
    if (!ok) {
      await this.record(auth, route, 'INVALID_RANGE');
      identityError(400, 'INVALID_RANGE');
    }
    return out;
  }

  private async period(
    auth: CustomerTokenAuth,
    route: string,
    raw: { from?: string; to?: string },
  ): Promise<{ from: string; to: string }> {
    const period = statementPeriod(raw, todayIn(STATEMENT_TIMEZONE));
    if (!period) {
      await this.record(auth, route, 'INVALID_RANGE');
      identityError(400, 'INVALID_RANGE');
    }
    return period;
  }

  private async build(
    auth: CustomerTokenAuth,
    period: { from: string; to: string },
  ): Promise<CsStatementDto> {
    const start = startOfDayIn(period.from, STATEMENT_TIMEZONE);
    const end = startOfDayIn(nextDay(period.to), STATEMENT_TIMEZONE);
    const branchIds = [...auth.client.allowedBranchIds];
    const { stages, mapping } = await this.stages.maps();
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const token = await tx.csCustomerToken.findUniqueOrThrow({
          where: { id: auth.tokenId },
          select: {
            channel: true,
            senderHash: true,
            grantKind: true,
            customer: { select: { number: true, name: true, companyName: true, profileId: true } },
          },
        });
        const { customer } = token;
        const requests = await this.requests(tx, auth, token, { start, end }, branchIds);
        const bookings = await this.bookings(tx, auth, { start, end }, branchIds, stages, mapping);
        const own = token.grantKind !== 'CONTACT_PHONE';
        return {
          customer: {
            number: customer.number,
            label: (customer.companyName ?? customer.name).slice(0, 200),
          },
          period,
          generatedAt: new Date().toISOString(),
          requests,
          bookings,
          // F206-3: an authorized person's token runs no invoice query at all.
          invoices: own ? await this.invoices(tx, auth, period, branchIds) : null,
          invoicesHidden: own ? null : 'CONTACT',
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * The requests the token holder owns (F206-1), by a verified link only: made with a token of
   * this customer, under a signed identity bound to its profile, or (WhatsApp only, F206-5) by
   * the same verified WhatsApp sender as the token.
   */
  private async requests(
    tx: Tx,
    auth: CustomerTokenAuth,
    token: { channel: string; senderHash: string | null; customer: { profileId: string | null } },
    range: { start: Date; end: Date },
    branchIds: string[],
  ): Promise<CsStatementSection<CsStatementRequestDto>> {
    const sameSender =
      token.channel === 'whatsapp' && token.senderHash
        ? (
            await tx.$queryRaw<{ id: string }[]>`
              SELECT r."id" FROM "cs_booking_requests" r
              WHERE r."sender_channel" = 'whatsapp'
                AND r."created_at" >= ${range.start} AND r."created_at" < ${range.end}
                AND encode(sha256(convert_to(
                      'whatsapp:+' || regexp_replace(r."sender_id", '[^0-9]', '', 'g'), 'UTF8')),
                    'hex') = ${token.senderHash}`
          ).map((r) => r.id)
        : [];
    const where: Prisma.CsBookingRequestWhereInput = {
      AND: [
        { createdAt: { gte: range.start, lt: range.end } },
        {
          OR: [
            { customerId: auth.customerId },
            ...(token.customer.profileId ? [{ profileId: token.customer.profileId }] : []),
            ...(sameSender.length > 0 ? [{ id: { in: sameSender } }] : []),
          ],
        },
        // As GET /cs/booking-requests (servedBy, F206-6): its branch, or a routing candidate.
        {
          OR: [
            { branchId: { in: branchIds } },
            { branchId: null, allowedBranchIds: { hasSome: branchIds } },
          ],
        },
      ],
    };
    const count = await tx.csBookingRequest.count({ where });
    const rows = await tx.csBookingRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CS_STATEMENT_MAX_ROWS,
      include: {
        origin: { select: { nameAr: true, nameEn: true } },
        destination: { select: { nameAr: true, nameEn: true } },
        booking: { select: { number: true } },
      },
    });
    const codes = [...new Set(rows.map((r) => r.priceCategoryCode).filter((c) => c !== null))];
    const categories = new Map(
      (
        await tx.priceCategory.findMany({
          where: { code: { in: codes } },
          select: { code: true, nameAr: true, nameEn: true, defaultUnit: true },
        })
      ).map((c) => [c.code, c]),
    );
    return section(
      rows.map((row) => {
        const names = storedBotNames(row.botNames);
        const category = row.priceCategoryCode ? categories.get(row.priceCategoryCode) : undefined;
        return {
          reference: row.reference,
          createdAt: row.createdAt.toISOString(),
          origin: row.origin ? { ar: row.origin.nameAr, en: row.origin.nameEn } : names.origin,
          destination: row.destination
            ? { ar: row.destination.nameAr, en: row.destination.nameEn }
            : names.destination,
          goods: {
            category: category ? { ar: category.nameAr, en: category.nameEn } : null,
            quantity: toDecimalString(row.quantity),
            unit: category?.defaultUnit ?? null,
          },
          status: stateOf(row),
          bookingNumber: row.status === 'APPROVED' ? (row.booking?.number ?? null) : null,
        };
      }),
      count,
    );
  }

  /** The bookings whose customer is the token's customer, of every status, without prices. */
  private async bookings(
    tx: Tx,
    auth: CustomerTokenAuth,
    range: { start: Date; end: Date },
    branchIds: string[],
    stages: Parameters<typeof trackOf>[1],
    mapping: Parameters<typeof trackOf>[2],
  ): Promise<CsStatementSection<CsStatementBookingDto>> {
    const where: Prisma.BookingWhereInput = {
      customerId: auth.customerId,
      branchId: { in: branchIds },
      createdAt: { gte: range.start, lt: range.end },
    };
    const count = await tx.booking.count({ where });
    const rows = await tx.booking.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CS_STATEMENT_MAX_ROWS,
      select: {
        number: true,
        createdAt: true,
        status: true,
        cargoDescription: true,
        origin: { select: { nameAr: true, nameEn: true } },
        destination: { select: { nameAr: true, nameEn: true } },
        shipment: {
          select: {
            number: true,
            status: true,
            createdAt: true,
            destination: { select: placeSelect },
            currentLocation: { select: placeSelect },
            events: { select: { occurredAt: true }, orderBy: { occurredAt: 'desc' }, take: 1 },
            pods: { select: { deliveredAt: true }, orderBy: { deliveredAt: 'desc' }, take: 1 },
          },
        },
      },
    });
    return section(
      rows.map((b) => {
        const s = b.shipment;
        const track = trackOf(
          {
            state: 'approved',
            booking: {
              status: b.status,
              shipment: s && {
                number: s.number,
                status: s.status,
                destination: s.destination,
                currentLocation: s.currentLocation,
                updatedAt: s.events[0]?.occurredAt ?? s.createdAt,
              },
            },
          },
          stages,
          mapping,
        );
        return {
          number: b.number,
          createdAt: b.createdAt.toISOString(),
          origin: { ar: b.origin.nameAr, en: b.origin.nameEn },
          destination: { ar: b.destination.nameAr, en: b.destination.nameEn },
          cargoDescription: b.cargoDescription,
          status: b.status,
          shipment: s
            ? {
                number: s.number,
                stage: track.stage,
                deliveredAt: s.pods[0]?.deliveredAt.toISOString() ?? null,
              }
            : null,
        };
      }),
      count,
    );
  }

  /**
   * The customer's approved invoices dated in the period, as /cs/me/invoices shows them, with
   * per-currency totals over every one of them, before the row cap (F206-2).
   */
  private async invoices(
    tx: Tx,
    auth: CustomerTokenAuth,
    period: { from: string; to: string },
    branchIds: string[],
  ): Promise<NonNullable<CsStatementDto['invoices']>> {
    const filter = Prisma.sql`
      i."customer_id" = ${auth.customerId}::uuid
      AND i."branch_id" IN ${uuidList(branchIds)}
      AND i."invoice_date" >= ${toDbDate(period.from)}::date
      AND i."invoice_date" <= ${toDbDate(period.to)}::date`;
    const rows = await tx.$queryRaw<InvoiceRow[]>`
      SELECT i."number", s."number" AS "shipmentNumber", i."invoice_date", i."due_date",
             i."currency", i."total", i."paid_amount", i."credited_amount", i."balance"
      FROM "cs_invoices" i
      LEFT JOIN "cs_shipments" s ON s."id" = i."shipment_id"
      WHERE ${filter}
      ORDER BY i."invoice_date" DESC, i."number" DESC
      LIMIT ${CS_STATEMENT_MAX_ROWS}`;
    const totals = await tx.$queryRaw<TotalRow[]>`
      SELECT i."currency", count(*) AS "count", sum(i."total") AS "total",
             sum(i."paid_amount") AS "paid", sum(i."credited_amount") AS "credited",
             sum(i."balance") AS "balance"
      FROM "cs_invoices" i
      WHERE ${filter}
      GROUP BY i."currency"
      ORDER BY i."currency"`;
    const count = totals.reduce((n, t) => n + Number(t.count), 0);
    const dtos: CsInvoiceDto[] = rows.map((r) => ({
      number: r.number,
      shipmentNumber: r.shipmentNumber,
      invoiceDate: fromDbDate(r.invoice_date),
      dueDate: fromDbDate(r.due_date),
      currency: r.currency,
      total: toDecimalString(r.total),
      paid: toDecimalString(r.paid_amount),
      credited: toDecimalString(r.credited_amount),
      balance: toDecimalString(r.balance),
    }));
    const totalDtos: CsStatementInvoiceTotalDto[] = totals.map((t) => ({
      currency: t.currency,
      count: Number(t.count),
      total: toDecimalString(t.total),
      paid: toDecimalString(t.paid),
      credited: toDecimalString(t.credited),
      balance: toDecimalString(t.balance),
    }));
    return { ...section(dtos, count), totals: totalDtos };
  }
}
