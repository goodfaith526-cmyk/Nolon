import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CsPaymentInstructionsDto,
  PaymentInstructionDecision,
  PaymentInstructionDto,
  PaymentInstructionInput,
  PaymentInstructionStatus,
  PaymentInstructionUpdate,
} from '@nolon/shared';
import { AuditService, changedFields } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { assertBranchAccess, branchScope, listBranchScope } from '../auth/branch-scope.js';
import { lockActiveBranches, lockBranchRule } from '../common/branch-locks.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { PaymentInstruction, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/** The most rows the staff list shows (newest first within a branch and currency). */
const LIST_LIMIT = 500;

/** The fields the audit log shows, in this order. */
const AUDITED_FIELDS = ['currency', 'textAr', 'textEn', 'status', 'version'] as const;

const withNames = {
  branch: { select: { code: true } },
  createdBy: { select: { fullName: true } },
  editedBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
} as const satisfies Prisma.PaymentInstructionInclude;

type Row = Prisma.PaymentInstructionGetPayload<{ include: typeof withNames }>;

export interface PaymentInstructionFilters {
  branchId?: string;
  currency?: string;
  status?: PaymentInstructionStatus;
}

/**
 * How a customer pays (plan 04 section 4.1), per branch and currency, both required: no general
 * row. Branch-owned (AGENTS.md rule 2). A draft is edited; another person than its maker approves
 * it, retiring the approved one of its branch and currency in the same transaction; an approved one
 * is never edited, only retired. The database holds one approved per branch and currency (unique
 * index) and refuses editing a decided row (trigger). Every change is in the audit log.
 */
@Injectable()
export class PaymentInstructionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currencies: CurrenciesService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, query: PaymentInstructionFilters): Promise<PaymentInstructionDto[]> {
    const rows = await this.prisma.paymentInstruction.findMany({
      where: {
        ...listBranchScope(user, query.branchId),
        ...(query.currency ? { currency: query.currency } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: withNames,
      orderBy: [{ branch: { code: 'asc' } }, { currency: 'asc' }, { createdAt: 'desc' }],
      take: LIST_LIMIT,
    });
    return rows.map((r) => toDto(r, user));
  }

  /** 404 for one of another branch: its existence is not disclosed. */
  async get(user: AuthUser, id: string): Promise<PaymentInstructionDto> {
    const row = await this.prisma.paymentInstruction.findFirst({
      where: { id, ...branchScope(user) },
      include: withNames,
    });
    if (!row) throw new NotFoundException('Payment instructions not found');
    return toDto(row, user);
  }

  /** A draft in one of the user's branches, in an active currency. */
  async create(user: AuthUser, input: PaymentInstructionInput): Promise<PaymentInstructionDto> {
    assertBranchAccess(user, input.branchId);
    const created = await this.prisma.$transaction(async (tx) => {
      if (!(await lockActiveBranches(tx, [input.branchId])).has(input.branchId)) {
        throw new ConflictException('Unknown or inactive branch');
      }
      await requireBranchMemberInTx(tx, user, input.branchId);
      await this.currencies.requireActiveInTx(tx, input.currency);
      const row = await tx.paymentInstruction.create({
        data: {
          branchId: input.branchId,
          currency: input.currency,
          textAr: input.textAr,
          textEn: input.textEn,
          createdById: user.id,
          editedById: user.id,
        },
      });
      await this.log(tx, user, 'CREATED', null, row);
      return row;
    });
    return this.get(user, created.id);
  }

  /** Drafts only, at the version the person saw. */
  async update(
    user: AuthUser,
    id: string,
    input: PaymentInstructionUpdate,
  ): Promise<PaymentInstructionDto> {
    await this.prisma.$transaction(async (tx) => {
      const before = await lockRow(tx, user, id, input.version);
      if (before.status !== 'DRAFT') {
        throw new ConflictException('Only a draft is edited: retire it and write a new one');
      }
      const after = await tx.paymentInstruction.update({
        where: { id },
        // The editor now wrote the text: they may not approve it (F140-1).
        data: {
          textAr: input.textAr,
          textEn: input.textEn,
          editedById: user.id,
          version: { increment: 1 },
        },
      });
      await this.log(tx, user, 'UPDATED', before, after);
    });
    return this.get(user, id);
  }

  /**
   * A draft becomes the instructions of its branch and currency, approved by another person than
   * its maker and than the writer of its current text (403 SAME_PERSON, F140-1), in a currency
   * still active. The approved one it replaces is
   * retired in the same transaction, under a lock of the branch and currency, so there is never a
   * moment with two or none in between.
   */
  async approve(
    user: AuthUser,
    id: string,
    input: PaymentInstructionDecision,
  ): Promise<PaymentInstructionDto> {
    await this.prisma.$transaction(async (tx) => {
      const draft = await lockRow(tx, user, id, input.version);
      if (draft.status !== 'DRAFT') throw new ConflictException('Only a draft is approved');
      if (draft.createdById === user.id || draft.editedById === user.id) {
        throw new ForbiddenException({
          message: 'Another person than the one who wrote them approves payment instructions',
          code: 'SAME_PERSON',
        });
      }
      await this.currencies.requireActiveInTx(tx, draft.currency);
      await lockBranchRule(tx, `payment-instructions:${draft.currency}`, [draft.branchId]);
      // Locked: a retirement of it running now commits first (and it is no longer approved here)
      // or waits for this approval.
      const held = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "payment_instructions"
        WHERE "branch_id" = ${draft.branchId}::uuid AND "currency" = ${draft.currency}
          AND "status" = 'APPROVED'
        FOR UPDATE`;
      const now = new Date();
      for (const { id: currentId } of held) {
        const current = await tx.paymentInstruction.findUniqueOrThrow({ where: { id: currentId } });
        await this.retireRow(tx, user, current, now);
      }
      const after = await tx.paymentInstruction.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedById: user.id,
          approvedAt: now,
          version: { increment: 1 },
        },
      });
      await this.log(tx, user, 'APPROVED', draft, after);
    });
    return this.get(user, id);
  }

  /** A draft or the approved one, withdrawn: the bot then says staff will send how to pay. */
  async retire(
    user: AuthUser,
    id: string,
    input: PaymentInstructionDecision,
  ): Promise<PaymentInstructionDto> {
    await this.prisma.$transaction(async (tx) => {
      const row = await lockRow(tx, user, id, input.version);
      if (row.status === 'RETIRED') throw new ConflictException('Already retired');
      await this.retireRow(tx, user, row, new Date());
    });
    return this.get(user, id);
  }

  /**
   * For the bot (plan 04 section 4.1): the approved instructions of exactly this branch and
   * currency, or null. Never another branch, another currency or a "nearest" row.
   */
  async approvedFor(branchId: string, currency: string): Promise<CsPaymentInstructionsDto | null> {
    const row = await this.prisma.paymentInstruction.findFirst({
      where: { branchId, currency, status: 'APPROVED' },
      include: { branch: { select: { code: true } } },
    });
    return row
      ? {
          id: row.id,
          version: row.version,
          branchCode: row.branch.code,
          currency: row.currency,
          textAr: row.textAr,
          textEn: row.textEn,
        }
      : null;
  }

  private async retireRow(
    tx: Tx,
    user: AuthUser,
    before: PaymentInstruction,
    at: Date,
  ): Promise<void> {
    const after = await tx.paymentInstruction.update({
      where: { id: before.id },
      data: { status: 'RETIRED', retiredById: user.id, retiredAt: at, version: { increment: 1 } },
    });
    await this.log(tx, user, 'CANCELLED', before, after);
  }

  private async log(
    tx: Tx,
    user: AuthUser,
    action: 'CREATED' | 'UPDATED' | 'APPROVED' | 'CANCELLED',
    before: PaymentInstruction | null,
    after: PaymentInstruction,
  ): Promise<void> {
    await this.audit.record(tx, user, {
      branchId: after.branchId,
      entity: 'PAYMENT_INSTRUCTION',
      entityId: after.id,
      reference: `${after.currency} v${after.version}`,
      action,
      changes: changedFields(before, after, AUDITED_FIELDS),
    });
  }
}

/**
 * The row locked for update and read after the lock, for a write by `user`: 404 outside their
 * branches, 403 unless they are still a member of its branch, 409 when their version is stale.
 */
async function lockRow(
  tx: Tx,
  user: AuthUser,
  id: string,
  version: number,
): Promise<PaymentInstruction> {
  await tx.$queryRaw`SELECT 1 FROM "payment_instructions" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const row = await tx.paymentInstruction.findFirst({ where: { id, ...branchScope(user) } });
  if (!row) throw new NotFoundException('Payment instructions not found');
  await requireBranchMemberInTx(tx, user, row.branchId);
  if (row.version !== version) {
    throw new ConflictException('The payment instructions changed: open them again');
  }
  return row;
}

function toDto(r: Row, user: AuthUser): PaymentInstructionDto {
  const draft = r.status === 'DRAFT';
  return {
    id: r.id,
    branchId: r.branchId,
    branchCode: r.branch.code,
    currency: r.currency,
    textAr: r.textAr,
    textEn: r.textEn,
    status: r.status,
    version: r.version,
    createdById: r.createdById,
    createdByName: r.createdBy.fullName,
    editedByName: r.editedBy.fullName,
    createdAt: r.createdAt.toISOString(),
    approvedByName: r.approvedBy?.fullName ?? null,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    retiredAt: r.retiredAt?.toISOString() ?? null,
    actions: {
      canEdit: draft && user.access.has('payment_instructions:update', r.branchId),
      canApprove:
        draft &&
        r.createdById !== user.id &&
        r.editedById !== user.id &&
        user.access.has('payment_instructions:approve', r.branchId),
      canRetire:
        r.status !== 'RETIRED' && user.access.has('payment_instructions:cancel', r.branchId),
    },
  };
}
