import { randomInt } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Page,
  PartnerDto,
  PartnerInput,
  PartnerKind,
  PartnerSummaryDto,
  PartnerUpdateRequest,
} from '@nolon/shared';
import { AuditService, changedFields } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { assertBranchAccess, branchScope, listBranchScope } from '../auth/branch-scope.js';
import { partnerOutletScope } from '../auth/outlet-scope.js';
import { lockActiveBranches } from '../common/branch-locks.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PageQuery } from '../common/validation.js';
import { fieldRefusal } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Partner, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { SuppliersService } from '../payables/suppliers.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

export interface PartnerFilters extends PageQuery {
  branchId?: string;
  kind?: PartnerKind;
  isActive?: boolean;
}

const details = {
  supplier: { select: { name: true } },
  referralCodes: { where: { retiredAt: null }, select: { code: true } },
  channelBindings: {
    where: { revokedAt: null },
    select: { createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
} satisfies Prisma.PartnerInclude;

type PartnerWithDetails = Prisma.PartnerGetPayload<{ include: typeof details }>;

/** The fields the audit log shows for a partner, in this order. */
const AUDITED_FIELDS = [
  'kind',
  'name',
  'phone',
  'email',
  'countryCode',
  'locationId',
  'supplierId',
  'currency',
  'notes',
  'referralWindowDays',
  'isActive',
] as const;

/**
 * Partners of the network (docs/plans/02-business-model-batch-1.md 3.1): sales outlets, origin
 * consolidators, overseas agents and distributors. Branch-owned (AGENTS.md rule 2): every read
 * and write is limited to the user's branches, and the branch never changes. This batch keeps
 * them as master data only: no commission, accrual, journal entry or settlement.
 */
@Injectable()
export class PartnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currencies: CurrenciesService,
    private readonly masterData: MasterDataService,
    private readonly suppliers: SuppliersService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, query: PartnerFilters): Promise<Page<PartnerSummaryDto>> {
    const where: Prisma.PartnerWhereInput = {
      ...listBranchScope(user, query.branchId),
      ...partnerOutletScope(user),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { number: { contains: query.q, mode: 'insensitive' } },
              { phone: { contains: query.q.replace(/\s/g, '') } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.partner.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.partner.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: query.page, pageSize: query.pageSize };
  }

  /** 404 for a partner of another branch: its existence is not disclosed. */
  async get(user: AuthUser, id: string): Promise<PartnerDto> {
    const partner = await this.prisma.partner.findFirst({
      where: { id, ...branchScope(user), ...partnerOutletScope(user) },
      include: details,
    });
    if (!partner) throw new NotFoundException('Partner not found');
    return toDto(partner, user);
  }

  async create(user: AuthUser, input: PartnerInput): Promise<PartnerDto> {
    assertBranchAccess(user, input.branchId);
    const created = await this.prisma.$transaction(async (tx) => {
      if (!(await lockActiveBranches(tx, [input.branchId])).has(input.branchId)) {
        throw new BadRequestException('Unknown or inactive branch');
      }
      await requireBranchMemberInTx(tx, user, input.branchId);
      await this.checkReferences(tx, input);
      checkReferralFields(input.kind, input.referralWindowDays);
      const number = formatDocumentNumber('PTR', await nextSequenceValue(tx, 'PARTNER'));
      const partner = await tx.partner.create({
        data: {
          number,
          kind: input.kind,
          branchId: input.branchId,
          name: input.name,
          phone: input.phone ?? null,
          email: input.email ?? null,
          countryCode: input.countryCode,
          locationId: input.locationId ?? null,
          supplierId: input.supplierId ?? null,
          currency: input.currency,
          notes: input.notes ?? null,
          referralWindowDays: input.referralWindowDays ?? null,
          createdById: user.id,
        },
      });
      if (partner.kind === 'REFERRER') await newReferralCodeInTx(tx, partner.id);
      await this.log(tx, user, 'CREATED', null, partner);
      return partner;
    });
    return this.get(user, created.id);
  }

  /** Locks the partner, checks the new references against what it will hold, and logs the edit. */
  async update(user: AuthUser, id: string, input: PartnerUpdateRequest): Promise<PartnerDto> {
    await this.prisma.$transaction(async (tx) => {
      const before = await lockScoped(tx, user, id);
      await requireBranchMemberInTx(tx, user, before.branchId);
      await this.checkReferences(tx, {
        countryCode: input.countryCode ?? before.countryCode,
        locationId: input.locationId === undefined ? before.locationId : input.locationId,
        // Only a newly named location, supplier or currency must be active: one already held
        // stays, so a partner whose city was deactivated can still be edited or deactivated.
        heldLocationId: before.locationId,
        supplierId: input.supplierId === before.supplierId ? undefined : input.supplierId,
        currency: input.currency === before.currency ? undefined : input.currency,
      });
      // Plan 18: a referrer stays a referrer (its codes and customers), and no other kind becomes one.
      if (
        input.kind !== undefined &&
        (input.kind === 'REFERRER') !== (before.kind === 'REFERRER')
      ) {
        throw fieldRefusal('REFERRER_KIND_FIXED', 'A referrer cannot change kind', ['kind']);
      }
      if (input.referralWindowDays !== undefined) {
        checkReferralFields(before.kind, input.referralWindowDays);
      }
      const after = await tx.partner.update({ where: { id }, data: input });
      await this.log(tx, user, 'UPDATED', before, after);
    });
    return this.get(user, id);
  }

  /**
   * Plan 18, 3: a new customer code for a referrer; the live one is retired (it stops linking new
   * customers, and customers it linked stay linked). Audited.
   */
  async issueReferralCode(user: AuthUser, id: string): Promise<PartnerDto> {
    await this.prisma.$transaction(async (tx) => {
      const partner = await lockScoped(tx, user, id);
      await requireBranchMemberInTx(tx, user, partner.branchId);
      if (partner.kind !== 'REFERRER') {
        throw fieldRefusal('NOT_A_REFERRER', 'Only a referrer has a customer code', ['kind']);
      }
      const retired = await tx.referralCode.findFirst({
        where: { partnerId: id, retiredAt: null },
        select: { code: true },
      });
      await tx.referralCode.updateMany({
        where: { partnerId: id, retiredAt: null },
        data: { retiredAt: new Date(), livePartnerId: null },
      });
      const code = await newReferralCodeInTx(tx, id);
      await this.audit.record(tx, user, {
        branchId: partner.branchId,
        entity: 'PARTNER',
        entityId: partner.id,
        reference: `${partner.number} ${partner.name}`,
        action: 'UPDATED',
        changes: [{ field: 'referralCode', before: retired?.code ?? null, after: code }],
      });
    });
    return this.get(user, id);
  }

  /**
   * The location (when named) is in the partner's country, and active unless the partner already
   * holds it (`heldLocationId`); a supplier or currency named is active. Each is share-locked until
   * the caller commits.
   */
  private async checkReferences(
    tx: Tx,
    input: {
      countryCode: string;
      locationId?: string | null;
      heldLocationId?: string | null;
      supplierId?: string | null;
      currency?: string;
    },
  ): Promise<void> {
    if (input.locationId) {
      const location =
        input.locationId === input.heldLocationId
          ? await this.masterData.lockHeldLocationInTx(tx, input.locationId)
          : await this.masterData.requireLocationInTx(tx, input.locationId);
      if (location.countryCode !== input.countryCode) {
        throw fieldRefusal(
          'PARTNER_LOCATION_OTHER_COUNTRY',
          `The location ${location.code} is in ${location.countryCode}, not ${input.countryCode}`,
          ['locationId', 'countryCode'],
          { location: location.code, country: location.countryCode },
        );
      }
    }
    if (input.supplierId) await this.suppliers.requireActiveInTx(tx, input.supplierId);
    if (input.currency) await this.currencies.requireActiveInTx(tx, input.currency);
  }

  private async log(
    tx: Tx,
    user: AuthUser,
    action: 'CREATED' | 'UPDATED',
    before: Partner | null,
    after: Partner,
  ): Promise<void> {
    await this.audit.record(tx, user, {
      branchId: after.branchId,
      entity: 'PARTNER',
      entityId: after.id,
      reference: `${after.number} ${after.name}`,
      action,
      changes: changedFields(before, after, AUDITED_FIELDS),
    });
  }
}

/** The partner row locked for update, read after the lock; 404 outside the user's branches. */
async function lockScoped(tx: Tx, user: AuthUser, id: string): Promise<Partner> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "partners" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const partner =
    rows.length > 0 ? await tx.partner.findFirst({ where: { id, ...branchScope(user) } }) : null;
  if (!partner) throw new NotFoundException('Partner not found');
  return partner;
}

function toSummary(p: Partner): PartnerSummaryDto {
  return {
    id: p.id,
    number: p.number,
    kind: p.kind,
    branchId: p.branchId,
    name: p.name,
    phone: p.phone,
    countryCode: p.countryCode,
    locationId: p.locationId,
    isActive: p.isActive,
  };
}

function toDto(p: PartnerWithDetails, user: AuthUser): PartnerDto {
  return {
    ...toSummary(p),
    email: p.email,
    supplierId: p.supplierId,
    supplierName: p.supplier?.name ?? null,
    currency: p.currency,
    notes: p.notes,
    referralCode: p.referralCodes[0]?.code ?? null,
    referralWindowDays: p.referralWindowDays,
    chatLinkedAt: p.channelBindings[0]?.createdAt.toISOString() ?? null,
    actions: {
      canEdit: user.access.has('partners:update', p.branchId),
      canIssueReferralCode: p.kind === 'REFERRER' && user.access.has('partners:update', p.branchId),
    },
  };
}

/** Only a referrer has an expiry (plan 18, 4.2). */
function checkReferralFields(kind: PartnerKind, windowDays: number | null | undefined): void {
  if (windowDays !== undefined && windowDays !== null && kind !== 'REFERRER') {
    throw fieldRefusal('NOT_A_REFERRER', 'Only a referrer has a first-shipment expiry', [
      'referralWindowDays',
    ]);
  }
}

const CODE_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `r_` + 8 random [a-z0-9] (plan 18, 3). */
export function randomReferralCode(): string {
  let code = 'r_';
  for (let i = 0; i < 8; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
  return code;
}

/**
 * Inserts a new live code for the partner. A clash with an existing code (36^8 of them) inserts
 * nothing (ON CONFLICT, so the transaction is not aborted) and draws again.
 */
async function newReferralCodeInTx(tx: Tx, partnerId: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const code = randomReferralCode();
    const [row] = await tx.$queryRaw<{ code: string }[]>`
      INSERT INTO "referral_codes" ("code", "partner_id", "live_partner_id")
      VALUES (${code}, ${partnerId}::uuid, ${partnerId}::uuid)
      ON CONFLICT ("code") DO NOTHING RETURNING "code"`;
    if (row) return row.code;
    if (attempt >= 5) throw new Error('Could not draw a free referral code');
  }
}
