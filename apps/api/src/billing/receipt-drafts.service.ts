import { Injectable, NotFoundException } from '@nestjs/common';
import {
  RECEIPT_OPEN_INVOICES_MAX,
  type AssistantDraftApproveRequest,
  type AssistantDraftDto,
  type CreateReceiptRequest,
  type DraftPreCheckDto,
  type DraftStatus,
  type EntryDraftCheck,
  type EntryDraftSummaryDto,
  type ReceiptDraftCreateRequest,
  type ReceiptDraftDto,
  type ReceiptDraftListItemDto,
  type ReceiptDraftRequest,
  type ReceiptDraftUpdateRequest,
  type ReceiptCashAccountDto,
  type ReceiptOpenInvoiceDto,
} from '@nolon/shared';
import { AccountsService } from '../accounting/accounts.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { type Decimal, dec, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
import { fieldRefusal } from '../common/validation.js';
import {
  approvedFields,
  checkDraft,
  decimalKey,
  draftBranch,
  draftExpiry,
  draftStatus,
  isRefusal,
  patched,
  preCheck,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
  storedValue,
  withBranch,
} from '../drafts/draft-rules.js';
import {
  decidedVia,
  decideInTx,
  type DecisionVia,
  DraftsService,
  keyReused,
  lockDraftRow,
  lockReplacedInTx,
  listScope,
  type ReviewPage,
  myDraftItem,
  type MyDraftRow,
  type MyDraftsQuery,
  replaceInTx,
  storedDraftUnderKey,
  valuesOf,
  withReplaced,
  withReplacedBy,
  MY_DRAFTS_ORDER,
  lockKeyInTx,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { InvoicesService } from './invoices.service.js';
import { ReceiptsService } from './receipts.service.js';
import { receiptCompleteness, requireApprovable } from '../drafts/draft-completeness.js';

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

/** The receipt a stored draft proposes, as stored (a missing value is null; no fx rate). */
export function receiptRequestOf(d: DraftRow): ReceiptDraftRequest {
  return {
    customerId: d.customerId,
    receiptDate: d.receiptDate === null ? null : fromDbDate(d.receiptDate),
    currency: d.currency,
    amount: toDecimalStringOrNull(d.amount),
    cashAccountId: d.cashAccountId,
    reference: d.reference,
    notes: d.notes,
    allocations: d.allocations.map((a) => ({
      invoiceId: a.invoiceId,
      amount: toDecimalStringOrNull(a.amount),
    })),
  };
}

/** What a receipt draft still misses before it can be approved (the gate's missing values). */
export function receiptMissingFields(request: ReceiptDraftRequest): string[] {
  return receiptCompleteness(request).missing;
}

/** The receipt of a complete draft (the approval gate passed), as ReceiptsService takes it. */
function completeReceipt(d: ReceiptDraftRequest): CreateReceiptRequest {
  return {
    customerId: storedValue(d.customerId, 'customer'),
    receiptDate: storedValue(d.receiptDate, 'receipt date'),
    currency: storedValue(d.currency, 'currency'),
    amount: storedValue(d.amount, 'amount'),
    cashAccountId: storedValue(d.cashAccountId, 'cash account'),
    reference: d.reference ?? null,
    notes: d.notes ?? null,
    allocations: d.allocations.map((a) => ({
      invoiceId: storedValue(a.invoiceId, 'allocation invoice'),
      amount: storedValue(a.amount, 'allocation amount'),
    })),
  };
}

/** A create body's values (absent allocations are none yet), and the branch it names. */
function valuesOfCreate(body: Omit<ReceiptDraftCreateRequest, 'idempotencyKey'>): {
  values: ReceiptDraftRequest;
  branchId: string | null;
} {
  const { branchId, allocations, ...rest } = body;
  return { values: { ...rest, allocations: allocations ?? [] }, branchId: branchId ?? null };
}

/** sha256 of the normalised request: ids lower case, decimals canonical, null for absent. */
export function receiptRequestHash(input: ReceiptDraftRequest): string {
  const decimal = (v: string | null | undefined) => (v ? decimalKey(dec(v)) : null);
  return requestHash({
    customerId: input.customerId?.toLowerCase() ?? null,
    receiptDate: input.receiptDate ?? null,
    currency: input.currency ?? null,
    amount: decimal(input.amount),
    cashAccountId: input.cashAccountId?.toLowerCase() ?? null,
    reference: input.reference ?? null,
    notes: input.notes ?? null,
    allocations: input.allocations.map((a) => ({
      invoiceId: a.invoiceId?.toLowerCase() ?? null,
      amount: decimal(a.amount),
    })),
  });
}

/** A draft's checked values: its branch, its customer, the currency as NOLON writes it. */
interface CheckedReceipt {
  branchId: string;
  customerId: string | null;
  currency: string | null;
  amount: Decimal | null;
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
    private readonly invoices: InvoicesService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * The cash and bank accounts a receipt for this customer may use (the customer visible to the
   * user; the receipt is the customer's branch's): active and postable, the branch's or shared.
   */
  async cashAccounts(
    user: AuthUser,
    customerId: string,
    currency?: string,
  ): Promise<ReceiptCashAccountDto[]> {
    const customer = await this.customers.requireCustomer(user, customerId);
    const accounts = await this.accounts.cashAccountsFor(customer.branchId);
    // With the receipt's currency (the review screen's), only accounts kept in it: a receipt
    // is recorded in its cash account's currency.
    return accounts
      .filter((a) => currency === undefined || a.currency === currency)
      .map((a) => ({ ...a, isActive: true }));
  }

  /** The customer's open invoices a receipt may settle, oldest due first. */
  openInvoices(
    user: AuthUser,
    customerId: string,
    currency: string | undefined,
  ): Promise<ReceiptOpenInvoiceDto[]> {
    return this.invoices.openForCustomer(user, customerId, currency, RECEIPT_OPEN_INVOICES_MAX);
  }

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: ReceiptDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { values, branchId } = valuesOfCreate(valuesOf(body));
    return preCheck(withBranch(receiptRequestHash(values), branchId), async () => {
      const checked = await this.validate(user, values, branchId);
      const missingFields = receiptMissingFields(values);
      return {
        total:
          missingFields.length === 0 && checked.amount ? toDecimalString(checked.amount) : null,
        currency: missingFields.length === 0 ? checked.currency : null,
        missingFields,
      };
    });
  }

  /**
   * The checks a draft's values get on create and on a person's edit: a complete receipt's that
   * need no lock in full (prepareCreate, preCheck); one still missing values, those of the values
   * present. The draft's branch is the customer's (which a branch given must be); with no
   * customer yet, the branch given, one of the user's.
   */
  private async validate(
    user: AuthUser,
    values: ReceiptDraftRequest,
    branchId: string | null,
  ): Promise<CheckedReceipt> {
    if (receiptMissingFields(values).length === 0) {
      const request = completeReceipt(values);
      const prepared = await this.receipts.prepareCreate(user, request);
      const branch = draftBranch(user, branchId, prepared.branchId);
      await this.preCheck(values, branch, user);
      return {
        branchId: branch,
        customerId: prepared.customerId,
        currency: prepared.currency,
        amount: prepared.amount,
      };
    }
    const present = await this.receipts.checkPresent(user, values);
    const branch = draftBranch(user, branchId, present.branchId);
    await this.preCheck({ ...values, currency: present.currency ?? values.currency }, branch, user);
    return {
      branchId: branch,
      customerId: present.customerId,
      currency: present.currency,
      amount: values.amount ? dec(values.amount) : null,
    };
  }

  async create(
    user: AuthUser,
    body: ReceiptDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, ...rest } = body;
    const { values: input, branchId } = valuesOfCreate(rest);
    const hash = withReplaced(withBranch(receiptRequestHash(input), branchId), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'receipt_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real receipt that need no lock, on the values present; nothing is written.
    const prepared = await this.validate(user, input, branchId);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'receipt_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'receipt_drafts', scope);
        const existing = await tx.receiptDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // The user holds the branch now, as stored (not only as their request loaded it).
        await requireBranchMemberInTx(tx, user, prepared.branchId);
        if (replaced) await replaceInTx(tx, replaced);
        const draft = await tx.receiptDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId: prepared.branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            ...columnsOf(input, prepared),
          },
          select: { id: true },
        });
        await tx.receiptDraftAllocation.createMany({ data: allocationRows(draft.id, input) });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /**
   * A person fills in or changes values of an open draft, at the version they read: the values
   * are checked as on create (a customer named must be of the draft's branch), and the version
   * moves on. The assistant's request (its payload hash) stays the draft's, so a replay of that
   * create still finds this draft.
   */
  async update(
    user: AuthUser,
    id: string,
    input: ReceiptDraftUpdateRequest,
  ): Promise<ReceiptDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    const values = patched(receiptRequestOf(current), patch);
    const checked = await this.validate(user, values, current.branchId);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'receipt_drafts', id);
      if (!locked) throw new NotFoundException('Receipt draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.receiptDraft.update({
        where: { id },
        data: { ...columnsOf(values, checked), version: { increment: 1 } },
      });
      if (patch.allocations !== undefined) {
        await tx.receiptDraftAllocation.deleteMany({ where: { draftId: id } });
        await tx.receiptDraftAllocation.createMany({ data: allocationRows(id, values) });
      }
    });
    return this.get(user, id);
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

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
    page?: ReviewPage,
  ): Promise<ReceiptDraftListItemDto[]> {
    const now = new Date();
    const scope = listScope(user, mine, page);
    const drafts = await this.prisma.receiptDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...scope.where,
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: scope.take,
    });
    return drafts.map((d) => ({
      ...baseFields(d, user, now),
      lineCount: d.allocations.length,
      amount: toDecimalStringOrNull(d.amount),
      currency: d.currency,
    }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('receipts:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'receipt',
        d,
        d.receiptId === null
          ? null
          : {
              type: 'receipt',
              id: d.receiptId,
              number: d.receiptNumber,
              path: `/receipts/${d.receiptId}`,
            },
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<ReceiptDraftDto> {
    return withReplacedBy(this.prisma, 'receipt_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<ReceiptDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    // Only the numbers of invoices the reviewer can see ('—' for an allocation without one yet).
    const ids = draft.allocations.flatMap((a) => (a.invoiceId === null ? [] : [a.invoiceId]));
    const invoices = await this.prisma.customerInvoice.findMany({
      where: { id: { in: ids }, ...branchScope(user) },
      select: { id: true, number: true },
    });
    const numbers = new Map(invoices.map((i) => [i.id, i.number ?? '—']));
    return {
      ...baseFields(draft, user, now),
      request: receiptRequestOf(draft),
      invoiceNumbers: draft.allocations.map((a) =>
        a.invoiceId === null ? '—' : (numbers.get(a.invoiceId) ?? '—'),
      ),
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
    // Nothing is checked, posted or recorded while the draft misses or holds an invalid value.
    requireApprovable(receiptCompleteness(receiptRequestOf(current)));
    const request = completeReceipt(receiptRequestOf(current));
    const prepared = await this.receipts.prepareCreate(user, request);
    await this.prisma.$transaction(async (tx) => {
      let receiptId = '';
      const decided = await decideInTx(tx, {
        table: 'receipt_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        gate: async () => {
          const row = await tx.receiptDraft.findUniqueOrThrow({ where: { id }, include: details });
          requireApprovable(receiptCompleteness(receiptRequestOf(row)));
        },
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
  /**
   * The checks of the receipt's cash account and allocations that need no lock, each refused at
   * its field: the account usable for the customer's branch and the currency; each allocation to
   * an approved invoice of this customer, in the receipt's currency, within what is left on it
   * (allocations to one invoice add up). The approval checks them again under the invoice locks.
   */
  private async preCheck(
    input: ReceiptDraftRequest,
    branchId: string,
    user: AuthUser,
  ): Promise<void> {
    // Each on the values present (a draft is saved with missing values).
    const cashAccountId = input.cashAccountId;
    if (cashAccountId) {
      await this.accounts
        .requireCash(this.prisma, cashAccountId, branchId, input.currency ?? null)
        .catch((error: unknown) => {
          if (!isRefusal(error)) throw error;
          throw fieldRefusal('CASH_ACCOUNT_NOT_USABLE', error.message, ['cashAccountId']);
        });
    }
    const ids = input.allocations.flatMap((a) => (a.invoiceId ? [a.invoiceId] : []));
    if (ids.length === 0) return;
    const customerId = input.customerId;
    if (!customerId) {
      // An allocation is to one of the customer's invoices: named once the customer is.
      const named = input.allocations.flatMap((a, i) =>
        a.invoiceId ? [`allocations.${i}.invoiceId`] : [],
      );
      throw fieldRefusal(
        null,
        "Name the customer before allocating to the customer's invoices",
        named,
      );
    }
    const invoices = await this.prisma.customerInvoice.findMany({
      where: { id: { in: ids }, customerId, ...branchScope(user) },
      select: {
        id: true,
        number: true,
        status: true,
        currency: true,
        total: true,
        paidAmount: true,
        creditedAmount: true,
      },
    });
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const allocated = new Map<string, Decimal>();
    input.allocations.forEach((a, i) => {
      if (!a.invoiceId) return;
      const invoice = byId.get(a.invoiceId);
      const at = `allocations.${i}`;
      if (!invoice) {
        throw fieldRefusal(
          'ALLOCATION_OTHER_CUSTOMER',
          'An allocation is to an invoice of another customer',
          [`${at}.invoiceId`],
        );
      }
      const params = { invoice: invoice.number ?? '', currency: invoice.currency };
      if (invoice.status !== 'APPROVED') {
        throw fieldRefusal(
          'ALLOCATION_NOT_APPROVED',
          `Invoice ${params.invoice} is not approved`,
          [`${at}.invoiceId`],
          params,
        );
      }
      if (input.currency && invoice.currency !== input.currency) {
        throw fieldRefusal(
          'ALLOCATION_OTHER_CURRENCY',
          `Invoice ${params.invoice} is in ${invoice.currency}; receive it in that currency`,
          [`${at}.invoiceId`],
          params,
        );
      }
      if (!a.amount) return;
      const left = invoice.total.minus(invoice.paidAmount).minus(invoice.creditedAmount);
      const sum = (allocated.get(invoice.id) ?? dec(0)).plus(dec(a.amount));
      allocated.set(invoice.id, sum);
      if (sum.gt(left)) {
        const balance = toDecimalString(left);
        throw fieldRefusal(
          'ALLOCATION_EXCEEDS_BALANCE',
          `Invoice ${params.invoice} has ${balance} ${invoice.currency} left`,
          [`${at}.amount`],
          { ...params, balance },
        );
      }
    });
  }

  /**
   * NOLON's checks of the receipt that need no lock (balances are checked on approval). While
   * the draft misses values, those of the values present: null when they pass.
   */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const request = receiptRequestOf(draft);
    const result = await checkDraft(async () => {
      const checked = await this.validate(user, request, draft.branchId);
      return {
        total: checked.amount ? toDecimalString(checked.amount) : null,
        currency: checked.currency,
      };
    });
    return result.ok && receiptMissingFields(request).length > 0 ? null : result;
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
    missingFields: receiptMissingFields(receiptRequestOf(d)),
  };
}

/** The header columns of a draft, a missing value as NULL. */
function columnsOf(values: ReceiptDraftRequest, checked: CheckedReceipt) {
  return {
    customerId: checked.customerId,
    receiptDate: values.receiptDate ? toDbDate(values.receiptDate) : null,
    currency: checked.currency ?? values.currency ?? null,
    amount: checked.amount,
    cashAccountId: values.cashAccountId ?? null,
    reference: values.reference ?? null,
    notes: values.notes ?? null,
  };
}

/** A draft's allocations as stored, a missing value as NULL. */
function allocationRows(draftId: string, values: ReceiptDraftRequest) {
  return values.allocations.map((a, i) => ({
    draftId,
    lineNo: i + 1,
    invoiceId: a.invoiceId ?? null,
    amount: a.amount ? dec(a.amount) : null,
  }));
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
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    customerId: d.customerId,
    customerName: d.customer?.name ?? null,
    subject: d.customer?.name ?? '',
    status,
    version: d.version,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    createdByName: d.createdBy.fullName,
    decidedByName: d.decidedBy?.fullName ?? null,
    decidedFromAssistant: d.decidedVia === 'ASSISTANT',
    decidedAt: d.decidedAt?.toISOString() ?? null,
    rejectReason: d.rejectReason,
    actions: { canEdit: open, canDecide: open },
    missingFields: receiptMissingFields(receiptRequestOf(d)),
    cashAccountCode: d.cashAccount?.code ?? null,
    cashAccountNameEn: d.cashAccount?.nameEn ?? null,
    cashAccountNameAr: d.cashAccount?.nameAr ?? null,
    receiptId: d.receiptId,
    receiptNumber: d.receipt?.number ?? null,
  };
}
