import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssistantDraftApproveRequest,
  AssistantDraftDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  ReceiptDraftCreateRequest,
  ReceiptDraftDto,
  ReceiptDraftListItemDto,
  ReceiptDraftRequest,
} from '@nolon/shared';
import { AccountsService } from '../accounting/accounts.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import {
  approvedFields,
  checkDraft,
  decimalKey,
  draftExpiry,
  draftStatus,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  type DecisionVia,
  DraftsService,
  decidedVia,
  decideInTx,
  keyReused,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReceiptsService } from './receipts.service.js';

const LABEL = 'receipt draft';
const ASSISTANT_ONLY = 'Receipt drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a receipt draft';

const details = {
  allocations: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  cashAccount: { select: { code: true, nameEn: true, nameAr: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  receipt: { select: { number: true } },
} satisfies Prisma.ReceiptDraftInclude;

type DraftRow = Prisma.ReceiptDraftGetPayload<{ include: typeof details }>;

/** The receipt a stored draft proposes, as ReceiptsService takes it (no fx rate: the table's). */
export function receiptRequestOf(d: DraftRow): ReceiptDraftRequest {
  return {
    customerId: d.customerId,
    receiptDate: fromDbDate(d.receiptDate),
    currency: d.currency,
    amount: toDecimalString(d.amount),
    cashAccountId: d.cashAccountId,
    reference: d.reference,
    notes: d.notes,
    allocations: d.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      amount: toDecimalString(a.amount),
    })),
  };
}

/** sha256 of the normalised request: ids lower case, decimals canonical, null for absent. */
export function receiptRequestHash(input: ReceiptDraftRequest): string {
  return requestHash({
    customerId: input.customerId.toLowerCase(),
    receiptDate: input.receiptDate,
    currency: input.currency,
    amount: decimalKey(dec(input.amount)),
    cashAccountId: input.cashAccountId.toLowerCase(),
    reference: input.reference ?? null,
    notes: input.notes ?? null,
    allocations: input.allocations.map((a) => ({
      invoiceId: a.invoiceId.toLowerCase(),
      amount: decimalKey(dec(a.amount)),
    })),
  });
}

/**
 * Customer receipt drafts proposed by the staff AI assistant (entry drafts, src/drafts). A person
 * approves a draft, which records an ordinary receipt and posts its entry (annex C rule 3)
 * through ReceiptsService in the same transaction, with their permissions and branches: the cash
 * account, the invoices' balances and the period are checked under ReceiptsService's locks then.
 * Access follows the customer's branch, as receipts do.
 */
@Injectable()
export class ReceiptDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receipts: ReceiptsService,
    private readonly accounts: AccountsService,
    private readonly drafts: DraftsService,
  ) {}

  async create(user: AuthUser, body: ReceiptDraftCreateRequest): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, ...input } = body;
    // The checks of a real receipt that need no lock; nothing is written.
    const prepared = await this.receipts.prepareCreate(user, input);
    await this.preCheck(input, prepared.branchId, user);
    const hash = receiptRequestHash(input);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.receiptDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        const draft = await tx.receiptDraft.create({
          data: {
            ...scope,
            branchId: prepared.branchId,
            customerId: prepared.customerId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            receiptDate: toDbDate(input.receiptDate),
            currency: prepared.currency,
            amount: prepared.amount,
            cashAccountId: input.cashAccountId,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
          },
          select: { id: true },
        });
        await tx.receiptDraftAllocation.createMany({
          data: input.allocations.map((a, i) => ({
            draftId: draft.id,
            lineNo: i + 1,
            invoiceId: a.invoiceId,
            amount: dec(a.amount),
          })),
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.receiptDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Receipt draft not found');
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, status?: DraftStatus): Promise<ReceiptDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.receiptDraft.findMany({
      where: { ...branchScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return drafts.map((d) => ({
      ...baseFields(d, user, now),
      lineCount: d.allocations.length,
      amount: toDecimalString(d.amount),
      currency: d.currency,
    }));
  }

  async get(user: AuthUser, id: string): Promise<ReceiptDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    // Only the numbers of invoices the reviewer can see.
    const invoices = await this.prisma.customerInvoice.findMany({
      where: { id: { in: draft.allocations.map((a) => a.invoiceId) }, ...branchScope(user) },
      select: { id: true, number: true },
    });
    const numbers = new Map(invoices.map((i) => [i.id, i.number ?? '—']));
    return {
      ...baseFields(draft, user, now),
      request: receiptRequestOf(draft),
      invoiceNumbers: draft.allocations.map((a) => numbers.get(a.invoiceId) ?? '—'),
      check,
    };
  }

  /**
   * A person approves the version they reviewed: the receipt is recorded and posted in the same
   * transaction as the approval. Approving an approved draft returns it as it is.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    via: DecisionVia = 'SESSION',
  ): Promise<ReceiptDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    const request = receiptRequestOf(current);
    const prepared = await this.receipts.prepareCreate(user, request);
    await this.prisma.$transaction(async (tx) => {
      let receiptId = '';
      const decided = await decideInTx(tx, {
        table: 'receipt_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        record: async () => {
          receiptId = await this.receipts.createInTx(tx, user, prepared, request);
        },
      });
      if (decided) {
        await tx.receiptDraft.update({
          where: { id },
          data: { ...approvedFields(user, decidedVia(via)), receiptId },
        });
      }
    });
    return this.get(user, id);
  }

  /** The draft as the assistant's chat card shows it (erp-agents docs/chat-draft-approval.md). */
  async forAssistant(user: AuthUser, id: string): Promise<AssistantDraftDto<ReceiptDraftDto>> {
    const draft = await this.get(user, id);
    return this.drafts.assistantView(user, 'receipt', 'receipt_drafts', draft, LABEL);
  }

  /** A person approves in the assistant's chat the content the card showed them. */
  async approveFromAssistant(
    user: AuthUser,
    id: string,
    input: AssistantDraftApproveRequest,
  ): Promise<ReceiptDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'receipt',
      'receipt_drafts',
      draft,
      LABEL,
      input.contentHash,
    );
    return this.approve(user, id, input.version, decision);
  }

  /** A person rejects in the assistant's chat. */
  async rejectFromAssistant(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<ReceiptDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'receipt',
      'receipt_drafts',
      draft,
      LABEL,
      null,
    );
    return this.reject(user, id, input, decision);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
    via: DecisionVia = 'SESSION',
  ): Promise<ReceiptDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'receipt_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.receiptDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason, decidedVia(via)),
      });
    });
    return this.get(user, id);
  }

  /**
   * The cash account fits the receipt, and the allocations name invoices of this customer in the
   * user's branches, so a draft never carries another branch's invoice id. ReceiptsService checks
   * both again, with balances and status, under its locks on approval.
   */
  private async preCheck(
    input: ReceiptDraftRequest,
    branchId: string,
    user: AuthUser,
  ): Promise<void> {
    await this.accounts.requireCash(this.prisma, input.cashAccountId, branchId, input.currency);
    const ids = input.allocations.map((a) => a.invoiceId);
    if (ids.length === 0) return;
    const found = await this.prisma.customerInvoice.count({
      where: { id: { in: ids }, customerId: input.customerId, ...branchScope(user) },
    });
    if (found !== new Set(ids).size) {
      throw new BadRequestException('An allocation is to an invoice of another customer');
    }
  }

  /** NOLON's checks of the receipt that need no lock (balances are checked on approval). */
  private check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      const request = receiptRequestOf(draft);
      const prepared = await this.receipts.prepareCreate(user, request);
      await this.preCheck(request, prepared.branchId, user);
      return { total: toDecimalString(prepared.amount), currency: prepared.currency };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.receiptDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Receipt draft not found');
    return draft;
  }
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.allocations.length,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<ReceiptDraftDto, 'request' | 'check' | 'invoiceNumbers'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('receipts:create');
  return {
    id: d.id,
    branchId: d.branchId,
    customerId: d.customerId,
    customerName: d.customer.name,
    subject: d.customer.name,
    status,
    version: d.version,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedFromAssistant: d.decidedVia === 'ASSISTANT',
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    actions: { canEdit: false, canDecide: open },
    cashAccountCode: d.cashAccount.code,
    cashAccountNameEn: d.cashAccount.nameEn,
    cashAccountNameAr: d.cashAccount.nameAr,
    receiptId: d.receiptId,
    receiptNumber: d.receipt?.number ?? null,
  };
}
