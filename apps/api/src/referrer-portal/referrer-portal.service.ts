import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  REFERRER_DAILY_REFUSALS,
  type ReferrerCustomerRequest,
  type ReferrerPortalDto,
} from '@nolon/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { todayIn } from '../common/dates.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { CustomersService } from '../customers/customers.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

/**
 * Plan 18, 8: a referral broker's own screen (REFERRER_STAFF). Everything is read for the one
 * referrer his login acts for (`user.referrerPartnerId`, from the session), never from the request:
 * the customers he registered (name and the phone's last digits), his commissions and statements.
 * He adds a customer by name and phone (plan 18, 3.3).
 */
@Injectable()
export class ReferrerPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async get(user: AuthUser): Promise<ReferrerPortalDto> {
    const partnerId = user.referrerPartnerId ?? null;
    const empty: ReferrerPortalDto = {
      broker: null,
      customers: [],
      commissions: [],
      pending: [],
      statements: [],
    };
    if (!partnerId) return empty;
    const partner = await this.prisma.partner.findFirst({
      where: { id: partnerId, kind: 'REFERRER', isActive: true },
      select: {
        name: true,
        number: true,
        referralCodes: { where: { retiredAt: null }, select: { code: true } },
      },
    });
    if (!partner) return empty;
    const code = partner.referralCodes[0]?.code ?? null;
    const bot = this.env.CS_REFERRER_BOT_URL;
    const [customers, accruals, statements] = await Promise.all([
      this.prisma.customer.findMany({
        where: { referredByPartnerId: partnerId },
        orderBy: [{ referredAt: 'desc' }, { id: 'asc' }],
        take: 200,
        select: {
          name: true,
          phone: true,
          referredAt: true,
          _count: { select: { shipments: { where: { status: { not: 'CANCELLED' } } } } },
        },
      }),
      this.prisma.commissionAccrual.findMany({
        where: { partnerId, role: 'REFERRER' },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 100,
        select: {
          createdAt: true,
          amount: true,
          currency: true,
          statementId: true,
          shipment: {
            select: {
              customer: { select: { name: true } },
              referral: { select: { referrerReason: true } },
            },
          },
        },
      }),
      this.prisma.partnerStatement.findMany({
        where: { partnerId, status: { in: ['BILLED', 'SETTLED'] } },
        orderBy: [{ periodTo: 'desc' }, { number: 'desc' }],
        take: 24,
        select: { number: true, periodTo: true, currency: true, total: true, status: true },
      }),
    ]);
    const pending = await this.prisma.commissionAccrual.groupBy({
      by: ['currency'],
      where: { partnerId, role: 'REFERRER', statementId: null },
      _sum: { amount: true },
      orderBy: { currency: 'asc' },
    });
    return {
      broker: {
        name: partner.name,
        number: partner.number,
        referralCode: code,
        customerLink: bot && code ? `${bot}${bot.includes('?') ? '&' : '?'}start=${code}` : null,
      },
      customers: customers.map((c) => ({
        name: c.name,
        phoneEnd: c.phone ? c.phone.slice(-3) : null,
        referredAt: (c.referredAt ?? new Date(0)).toISOString(),
        shipments: c._count.shipments,
      })),
      commissions: accruals.map((a) => ({
        date: a.createdAt.toISOString(),
        customerName: firstName(a.shipment.customer.name),
        reason: a.shipment.referral?.referrerReason ?? null,
        amount: a.amount.toFixed(),
        currency: a.currency,
        onStatement: a.statementId !== null,
      })),
      pending: pending
        .map((p) => ({
          currency: p.currency,
          amount: (p._sum.amount ?? new Prisma.Decimal(0)).toFixed(),
        }))
        .filter((p) => !new Prisma.Decimal(p.amount).isZero()),
      statements: statements.map((s) => ({
        number: s.number,
        periodTo: s.periodTo.toISOString().slice(0, 10),
        currency: s.currency,
        total: s.total.toFixed(),
        status: s.status as 'BILLED' | 'SETTLED',
      })),
    };
  }

  /**
   * Plan 18, 3.3: a new customer of this broker. Refused (409 CUSTOMER_EXISTS, saying nothing of
   * whose) when the phone is already a customer's or a profile's; each refusal is recorded and
   * audited with the phone's last 3 digits only, and after REFERRER_DAILY_REFUSALS in his branch's day every add is
   * refused with 429 TOO_MANY_ATTEMPTS until the next day. The broker's row is locked first, so his
   * attempts are counted one at a time.
   */
  async addCustomer(user: AuthUser, input: ReferrerCustomerRequest): Promise<ReferrerPortalDto> {
    const partnerId = user.referrerPartnerId ?? null;
    const outcome = await this.prisma.$transaction(async (tx) => {
      const rows = partnerId
        ? await tx.$queryRaw<
            { branch_id: string; number: string; name: string; timezone: string }[]
          >`
            SELECT p."branch_id"::text AS "branch_id", p."number", p."name", b."timezone"
            FROM "partners" p JOIN "branches" b ON b."id" = p."branch_id"
            WHERE p."id" = ${partnerId}::uuid AND p."kind" = 'REFERRER' AND p."is_active"
            FOR UPDATE OF p`
        : [];
      const partner = rows[0];
      if (!partnerId || !partner) return 'NO_BROKER' as const;
      const now = new Date();
      const recent = await tx.referrerCustomerAttempt.findMany({
        where: {
          partnerId,
          refused: true,
          createdAt: { gte: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) },
        },
        select: { createdAt: true },
      });
      const today = todayIn(partner.timezone, now);
      const refusedToday = recent.filter((r) => todayIn(partner.timezone, r.createdAt) === today);
      if (refusedToday.length >= REFERRER_DAILY_REFUSALS) return 'TOO_MANY' as const;
      // F239-4: never a hash of the phone (easily reversed): its last 3 digits only.
      const phoneEnd = input.phone.slice(-3);
      const made = await this.customers.referrerCustomerInTx(tx, user, partnerId, input);
      await tx.referrerCustomerAttempt.create({
        data: { partnerId, userId: user.id, phoneEnd, refused: made === 'TAKEN' },
      });
      if (made !== 'TAKEN') return 'ADDED' as const;
      await this.audit.record(tx, user, {
        branchId: partner.branch_id,
        entity: 'PARTNER',
        entityId: partnerId,
        reference: `${partner.number} ${partner.name}`,
        action: 'UPDATED',
        changes: [{ field: 'customerAddRefused', before: null, after: `phone ending ${phoneEnd}` }],
      });
      return 'TAKEN' as const;
    });
    if (outcome === 'NO_BROKER') {
      throw new HttpException(
        { code: 'NO_BROKER', message: 'This login acts for no active broker' },
        HttpStatus.CONFLICT,
      );
    }
    if (outcome === 'TOO_MANY') {
      throw new HttpException(
        { code: 'TOO_MANY_ATTEMPTS', message: 'Too many refused attempts today' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (outcome === 'TAKEN') {
      throw new HttpException(
        { code: 'CUSTOMER_EXISTS', message: 'This phone is already a Nolon customer' },
        HttpStatus.CONFLICT,
      );
    }
    return this.get(user);
  }
}
