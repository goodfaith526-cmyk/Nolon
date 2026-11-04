import { ConflictException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_COMMISSION_EVENT,
  type PartnerContractDto,
  type PartnerContractInput,
  type PartnerContractStatus,
} from '@nolon/shared';
import { AuditService, changedFields } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, fromDbDateOrNull, toDbDate } from '../common/dates.js';
import { dec } from '../common/money.js';
import { codedRefusal } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Partner, PartnerContract, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { MarginCommission } from '../rates/expected-margin.js';

type Tx = Prisma.TransactionClient;

/** The fields the audit log shows for a contract, under the partner, in this order. */
const AUDITED_FIELDS = [
  'priceCategoryCode',
  'basis',
  'value',
  'unit',
  'currency',
  'validFrom',
  'validTo',
  'accrualEvent',
  'notes',
  'status',
] as const;

/**
 * Partners' commission contracts (business model plan 3.4). A contract belongs to its partner's
 * branch (AGENTS.md rule 2); drafts are edited, an approved contract is only cancelled, never
 * edited. Nothing here accrues, posts or settles: it is read for the expected commission of a rate
 * card's expected margin (commissionFor), and (plan 07) for the event its commission accrues on.
 */
@Injectable()
export class PartnerContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currencies: CurrenciesService,
    private readonly masterData: MasterDataService,
    private readonly audit: AuditService,
  ) {}

  /** The partner's contracts, newest first; 404 for a partner outside the user's branches. */
  async list(user: AuthUser, partnerId: string): Promise<PartnerContractDto[]> {
    const partner = await this.prisma.partner.findFirst({
      where: { id: partnerId, ...branchScope(user) },
    });
    if (!partner) throw new NotFoundException('Partner not found');
    const contracts = await this.prisma.partnerContract.findMany({
      where: { partnerId },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return contracts.map((c) => toDto(c, partner.branchId, user));
  }

  async create(
    user: AuthUser,
    partnerId: string,
    input: PartnerContractInput,
  ): Promise<PartnerContractDto> {
    const created = await this.prisma.$transaction(async (tx) => {
      const partner = await lockPartner(tx, user, partnerId);
      await requireBranchMemberInTx(tx, user, partner.branchId);
      await this.checkReferences(tx, input, null);
      const contract = await tx.partnerContract.create({
        data: { ...fields(input, partner, null), partnerId, createdById: user.id },
      });
      await this.log(tx, user, partner, 'CREATED', null, contract);
      return contract;
    });
    return this.get(user, created.id);
  }

  /** Drafts only: an approved contract is cancelled and made again. */
  async update(
    user: AuthUser,
    id: string,
    input: PartnerContractInput,
  ): Promise<PartnerContractDto> {
    await this.prisma.$transaction(async (tx) => {
      const { partner, contract } = await this.lockContract(tx, user, id);
      if (contract.status !== 'DRAFT') {
        throw new ConflictException('Only a draft contract can be edited');
      }
      await this.checkReferences(tx, input, contract);
      const after = await tx.partnerContract.update({
        where: { id },
        data: fields(input, partner, contract),
      });
      await this.log(tx, user, partner, 'UPDATED', contract, after);
    });
    return this.get(user, id);
  }

  /**
   * A draft becomes the partner's contract for its category and dates: the partner must still be
   * active, and no other approved contract of the partner and category may cover any of its days
   * (409 CONTRACT_OVERLAP). Under the partner's row lock, so two approvals cannot both pass.
   */
  async approve(user: AuthUser, id: string): Promise<PartnerContractDto> {
    await this.prisma.$transaction(async (tx) => {
      const { partner, contract } = await this.lockContract(tx, user, id);
      if (contract.status !== 'DRAFT') {
        throw new ConflictException('Only a draft contract can be approved');
      }
      if (!partner.isActive) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'CONTRACT_PARTNER_INACTIVE',
          'The partner is no longer active',
        );
      }
      const overlapping = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "partner_contracts"
        WHERE "partner_id" = ${partner.id}::uuid AND "status" = 'APPROVED' AND "id" <> ${id}::uuid
          AND "price_category_code" IS NOT DISTINCT FROM ${contract.priceCategoryCode}
          AND "valid_from" <= COALESCE(${contract.validTo}::date, 'infinity'::date)
          AND COALESCE("valid_to", 'infinity'::date) >= ${contract.validFrom}::date
        LIMIT 1`;
      if (overlapping.length > 0) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'CONTRACT_OVERLAP',
          'Another approved contract of this partner covers the same category on these dates',
        );
      }
      await this.transition(tx, user, partner, contract, 'APPROVED', {
        approvedById: user.id,
        approvedAt: new Date(),
      });
    });
    return this.get(user, id);
  }

  async cancel(user: AuthUser, id: string): Promise<PartnerContractDto> {
    await this.prisma.$transaction(async (tx) => {
      const { partner, contract } = await this.lockContract(tx, user, id);
      if (contract.status === 'CANCELLED') {
        throw new ConflictException('The contract is already cancelled');
      }
      await this.transition(tx, user, partner, contract, 'CANCELLED', {});
    });
    return this.get(user, id);
  }

  /**
   * The commission a sales outlet earns on a card of `priceCategoryCode` on `date`, for its
   * expected margin: its approved contract of that category valid on the day, else its approved
   * contract for every category. The outlet must be an active sales outlet of the user's branches
   * (400 OUTLET_NOT_USABLE); `recorded`: the outlet a shipment was sold through, which counts even
   * if it was deactivated since.
   */
  async commissionFor(
    user: AuthUser,
    outletId: string,
    priceCategoryCode: string | null,
    date: string,
    recorded = false,
  ): Promise<MarginCommission> {
    const outlet = await this.prisma.partner.findFirst({
      where: {
        id: outletId,
        kind: 'SALES_OUTLET',
        ...(recorded ? {} : { isActive: true }),
        ...branchScope(user),
      },
    });
    if (!outlet) {
      throw codedRefusal(HttpStatus.BAD_REQUEST, 'OUTLET_NOT_USABLE', 'Not a usable sales outlet');
    }
    const day = toDbDate(date);
    const valid = {
      partnerId: outletId,
      status: 'APPROVED',
      validFrom: { lte: day },
      OR: [{ validTo: null }, { validTo: { gte: day } }],
    } satisfies Prisma.PartnerContractWhereInput;
    // Approval keeps one approved contract per category and day, so each lookup finds at most one.
    const contract =
      (priceCategoryCode
        ? await this.prisma.partnerContract.findFirst({ where: { ...valid, priceCategoryCode } })
        : null) ??
      (await this.prisma.partnerContract.findFirst({
        where: { ...valid, priceCategoryCode: null },
      }));
    if (!contract) return { kind: 'NO_CONTRACT' };
    return {
      kind: 'CONTRACT',
      contract: {
        basis: contract.basis,
        value: contract.value,
        unit: contract.unit,
        currency: contract.currency,
      },
    };
  }

  /**
   * For a partner's commission on a shipment (plan 07, 4.2), in the caller's transaction: the
   * partner's approved contract valid on `date` for `priceCategoryCode` (the category's own, else
   * the one for every category); with no category (lines of several), only the one for every
   * category. `anyOnDay`: whether any approved contract of the partner is valid that day.
   */
  async commissionContractInTx(
    tx: Tx,
    partnerId: string,
    priceCategoryCode: string | null,
    date: string,
  ): Promise<{ contract: PartnerContract | null; anyOnDay: boolean }> {
    const day = toDbDate(date);
    const valid = {
      partnerId,
      status: 'APPROVED',
      validFrom: { lte: day },
      OR: [{ validTo: null }, { validTo: { gte: day } }],
    } satisfies Prisma.PartnerContractWhereInput;
    // Approval keeps one approved contract per category and day, so each lookup finds at most one.
    const contract =
      (priceCategoryCode
        ? await tx.partnerContract.findFirst({ where: { ...valid, priceCategoryCode } })
        : null) ??
      (await tx.partnerContract.findFirst({ where: { ...valid, priceCategoryCode: null } }));
    const anyOnDay = contract !== null || (await tx.partnerContract.count({ where: valid })) > 0;
    return { contract, anyOnDay };
  }

  /** The contract a slot keeps once accrued (plan 07, 3.2), whatever its status now. */
  async contractInTx(tx: Tx, id: string): Promise<PartnerContract> {
    return tx.partnerContract.findUniqueOrThrow({ where: { id } });
  }

  /** The partner a commission is posted for: its number, name and supplier. */
  async partnerInTx(
    tx: Tx,
    id: string,
  ): Promise<Pick<Partner, 'id' | 'number' | 'name' | 'supplierId' | 'branchId'>> {
    return tx.partner.findUniqueOrThrow({
      where: { id },
      select: { id: true, number: true, name: true, supplierId: true, branchId: true },
    });
  }

  private async get(user: AuthUser, id: string): Promise<PartnerContractDto> {
    const contract = await this.prisma.partnerContract.findFirst({
      where: { id, partner: branchScope(user) },
      include: { partner: { select: { branchId: true } } },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    return toDto(contract, contract.partner.branchId, user);
  }

  /**
   * The contract and its partner, the partner row locked first (as approve and every edit take
   * it), the contract read after the lock; 404 outside the user's branches.
   */
  private async lockContract(
    tx: Tx,
    user: AuthUser,
    id: string,
  ): Promise<{ partner: Partner; contract: PartnerContract }> {
    const found = await tx.partnerContract.findFirst({
      where: { id, partner: branchScope(user) },
      select: { partnerId: true },
    });
    if (!found) throw new NotFoundException('Contract not found');
    const partner = await lockPartner(tx, user, found.partnerId);
    await requireBranchMemberInTx(tx, user, partner.branchId);
    const contract = await tx.partnerContract.findUniqueOrThrow({ where: { id } });
    return { partner, contract };
  }

  /**
   * A category named is active (one the draft already holds stays); a fixed amount's currency is
   * active (likewise). Share-locked until the caller commits.
   */
  private async checkReferences(
    tx: Tx,
    input: PartnerContractInput,
    held: PartnerContract | null,
  ): Promise<void> {
    const category = input.priceCategoryCode ?? null;
    if (category && category !== held?.priceCategoryCode) {
      await this.masterData.requirePriceCategoryInTx(tx, category);
    }
    const currency = input.basis === 'FIXED_PER_UNIT' ? (input.currency ?? null) : null;
    if (currency && currency !== held?.currency) {
      await this.currencies.requireActiveInTx(tx, currency);
    }
  }

  private async transition(
    tx: Tx,
    user: AuthUser,
    partner: Partner,
    contract: PartnerContract,
    to: PartnerContractStatus,
    data: Prisma.PartnerContractUncheckedUpdateInput,
  ): Promise<void> {
    const after = await tx.partnerContract.update({
      where: { id: contract.id },
      data: { ...data, status: to },
    });
    await this.log(
      tx,
      user,
      partner,
      to === 'APPROVED' ? 'APPROVED' : 'CANCELLED',
      contract,
      after,
    );
  }

  /** Under the partner: a first line naming the contract, then its fields before and after. */
  private async log(
    tx: Tx,
    user: AuthUser,
    partner: Partner,
    action: 'CREATED' | 'UPDATED' | 'APPROVED' | 'CANCELLED',
    before: PartnerContract | null,
    after: PartnerContract,
  ): Promise<void> {
    const audited = (c: PartnerContract) => ({
      ...c,
      validFrom: fromDbDate(c.validFrom),
      validTo: fromDbDateOrNull(c.validTo),
    });
    const changes = changedFields(before && audited(before), audited(after), AUDITED_FIELDS);
    await this.audit.record(tx, user, {
      branchId: partner.branchId,
      entity: 'PARTNER',
      entityId: partner.id,
      reference: `${partner.number} ${partner.name}`,
      action,
      changes: [
        { field: 'contract', before: before ? after.id : null, after: after.id },
        ...changes.map((c) => ({ ...c, field: `contract.${c.field}` })),
      ],
    });
  }
}

/** The partner row locked for update, read after the lock; 404 outside the user's branches. */
async function lockPartner(tx: Tx, user: AuthUser, id: string): Promise<Partner> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "partners" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const partner =
    rows.length > 0 ? await tx.partner.findFirst({ where: { id, ...branchScope(user) } }) : null;
  if (!partner) throw new NotFoundException('Partner not found');
  return partner;
}

/** A draft's fields; an event not sent keeps the draft's, or takes the partner kind's default. */
function fields(input: PartnerContractInput, partner: Partner, held: PartnerContract | null) {
  const fixed = input.basis === 'FIXED_PER_UNIT';
  return {
    priceCategoryCode: input.priceCategoryCode ?? null,
    basis: input.basis,
    value: dec(input.value),
    unit: fixed ? (input.unit ?? null) : null,
    currency: fixed ? (input.currency ?? null) : null,
    validFrom: toDbDate(input.validFrom),
    validTo: input.validTo ? toDbDate(input.validTo) : null,
    accrualEvent:
      input.accrualEvent ?? held?.accrualEvent ?? DEFAULT_COMMISSION_EVENT[partner.kind],
    notes: input.notes ?? null,
  };
}

function toDto(c: PartnerContract, branchId: string, user: AuthUser): PartnerContractDto {
  const draft = c.status === 'DRAFT';
  return {
    id: c.id,
    partnerId: c.partnerId,
    priceCategoryCode: c.priceCategoryCode,
    basis: c.basis,
    value: c.value.toFixed(),
    unit: c.unit,
    currency: c.currency,
    validFrom: fromDbDate(c.validFrom),
    validTo: fromDbDateOrNull(c.validTo),
    accrualEvent: c.accrualEvent,
    notes: c.notes,
    status: c.status,
    approvedAt: c.approvedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    actions: {
      canEdit: draft && user.access.has('partner_contracts:update', branchId),
      canApprove: draft && user.access.has('partner_contracts:approve', branchId),
      canCancel: c.status !== 'CANCELLED' && user.access.has('partner_contracts:cancel', branchId),
    },
  };
}
