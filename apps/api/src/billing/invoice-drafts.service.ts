import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssistantDraftApproveRequest,
  AssistantDraftDto,
  DraftPreCheckDto,
  DraftPriceSource,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  InvoiceDraftCreateRequest,
  InvoiceDraftDto,
  InvoiceDraftSuggestedValuesDto,
  InvoiceDraftLineInput,
  InvoiceDraftListItemDto,
  InvoiceDraftRequest,
  InvoiceDraftUpdateRequest,
  InvoiceSuggestRequest,
  InvoiceSuggestionDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope, withPermissions } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { dec, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
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
import {
  type InvoiceDraftValues,
  InvoicesService,
  type PriceableInvoiceLine,
} from './invoices.service.js';
import {
  type Completeness,
  invoiceCompleteness,
  requireApprovable,
} from '../drafts/draft-completeness.js';

const LABEL = 'invoice draft';
const ASSISTANT_ONLY = 'Invoice drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on an invoice draft';

const details = {
  lines: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  shipment: { select: { number: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  invoice: { select: { number: true } },
} satisfies Prisma.InvoiceDraftInclude;

type DraftRow = Prisma.InvoiceDraftGetPayload<{ include: typeof details }>;

/**
 * An invoice draft's approval gate (draft-completeness.ts): the invoice it proposes, with the
 * customer its shipment gave it.
 */
export function invoiceDraftCompleteness(d: DraftRow): Completeness {
  return invoiceCompleteness({ ...invoiceRequestOf(d), customerId: d.customerId });
}

/** The invoice a stored draft proposes, as stored (a missing value is null). */
export function invoiceRequestOf(d: DraftRow): InvoiceDraftRequest {
  return {
    shipmentId: d.shipmentId,
    currency: d.currency,
    invoiceDate: d.invoiceDate === null ? null : fromDbDate(d.invoiceDate),
    dueDate: d.dueDate === null ? null : fromDbDate(d.dueDate),
    notes: d.notes,
    lines: d.lines.map((l) => ({
      chargeTypeCode: l.chargeTypeCode,
      description: l.description,
      quantity: toDecimalStringOrNull(l.quantity),
      unitPrice: toDecimalStringOrNull(l.unitPrice),
    })),
  };
}

/** What an invoice draft still misses before it can be approved (the gate's missing values). */
export function invoiceMissingFields(d: DraftRow): string[] {
  return invoiceDraftCompleteness(d).missing;
}

/** An invoice draft's values as checked and priced: a line without a unit price is to be priced. */
interface InvoiceValues {
  shipmentId: string | null;
  currency?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  lines: InvoiceDraftLineInput[];
}

/**
 * The values once the draft can be priced (the shipment, currency, dates and each line's charge
 * and quantity given), in the shape prepareForShipment takes: a line without a unit price then
 * takes the system price. Null while any of those is missing.
 */
function priceable(values: InvoiceValues): (InvoiceDraftValues & { shipmentId: string }) | null {
  const { shipmentId, currency, invoiceDate, dueDate } = values;
  if (!shipmentId || !currency || !invoiceDate || !dueDate || values.lines.length === 0) {
    return null;
  }
  const lines: PriceableInvoiceLine[] = [];
  for (const l of values.lines) {
    if (!l.chargeTypeCode || !l.quantity) return null;
    lines.push({
      chargeTypeCode: l.chargeTypeCode,
      description: l.description ?? null,
      quantity: l.quantity,
      ...(l.unitPrice ? { unitPrice: l.unitPrice } : {}),
    });
  }
  return { shipmentId, currency, invoiceDate, dueDate, notes: values.notes ?? null, lines };
}

/** The invoice of a complete draft (the approval gate passed), its stored prices as typed. */
function completeInvoice(d: InvoiceDraftRequest): InvoiceDraftValues & { shipmentId: string } {
  return {
    shipmentId: storedValue(d.shipmentId, 'shipment'),
    currency: storedValue(d.currency, 'currency'),
    invoiceDate: storedValue(d.invoiceDate, 'invoice date'),
    dueDate: storedValue(d.dueDate, 'due date'),
    notes: d.notes ?? null,
    lines: d.lines.map((l) => ({
      chargeTypeCode: storedValue(l.chargeTypeCode, 'line charge'),
      description: l.description ?? null,
      quantity: storedValue(l.quantity, 'line quantity'),
      unitPrice: storedValue(l.unitPrice, 'line unit price'),
    })),
  };
}

/**
 * sha256 of the normalised request: ids lower case, decimals canonical, null for absent (a line
 * without a unit price asks for the system price). A complete request hashes as it always has.
 */
export function invoiceRequestHash(input: InvoiceValues): string {
  const decimal = (v: string | null | undefined) => (v ? decimalKey(dec(v)) : null);
  return requestHash({
    shipmentId: input.shipmentId?.toLowerCase() ?? null,
    currency: input.currency ?? null,
    invoiceDate: input.invoiceDate ?? null,
    dueDate: input.dueDate ?? null,
    notes: input.notes ?? null,
    lines: input.lines.map((l) => ({
      chargeTypeCode: l.chargeTypeCode ?? null,
      description: l.description ?? null,
      quantity: decimal(l.quantity),
      unitPrice: decimal(l.unitPrice),
    })),
  });
}

/** A create body's values, and the branch it names (security context, not a value). */
function valuesOfCreate(body: Omit<InvoiceDraftCreateRequest, 'idempotencyKey'>): {
  values: InvoiceValues;
  branchId: string | null;
} {
  const { branchId, shipmentId, lines, ...rest } = body;
  return {
    values: { ...rest, shipmentId: shipmentId ?? null, lines: lines ?? [] },
    branchId: branchId ?? null,
  };
}

/** A draft's checked values as stored, its lines priced when they could be. */
interface CheckedInvoice {
  branchId: string;
  customerId: string | null;
  currency: string | null;
  lines: {
    chargeTypeCode: string | null;
    description: string | null;
    quantity: Prisma.Decimal | null;
    unitPrice: Prisma.Decimal | null;
    priceSource: DraftPriceSource['source'];
    rateCardId: string | null;
  }[];
}

/**
 * Customer invoice drafts proposed by the staff AI assistant (entry drafts, src/drafts). A person
 * approves a draft, which creates an ordinary DRAFT invoice for the shipment through
 * InvoicesService in the same transaction, with their permissions and branches; nothing is posted
 * until that invoice is itself approved in NOLON. Access follows the shipment's owning branch, as
 * invoices do.
 */
@Injectable()
export class InvoiceDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
    private readonly drafts: DraftsService,
  ) {}

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: InvoiceDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { values, branchId } = valuesOfCreate(valuesOf(body));
    return preCheck(withBranch(invoiceRequestHash(values), branchId), async () => {
      const ready = priceable(values);
      if (ready === null) {
        const checked = await this.validate(user, values, branchId);
        const missingFields = invoiceCompleteness({
          ...values,
          customerId: checked.customerId,
        }).missing;
        return { total: null, currency: null, missingFields };
      }
      const prepared = await this.invoices.prepareForShipment(user, ready.shipmentId, ready, {
        everyLine: true,
      });
      draftBranch(user, branchId, prepared.branchId);
      return {
        total: toDecimalString(prepared.total),
        currency: prepared.currency,
        priceSources: prepared.lines.map((l) => ({
          source: l.priceSource,
          rateCardId: l.rateCardId,
        })),
        computed: prepared.lines.flatMap((l, i) =>
          l.priceSource === 'TYPED'
            ? []
            : [
                {
                  field: `lines.${i}.unitPrice`,
                  value: toDecimalString(l.unitPrice),
                  source: l.priceSource,
                  rateCardId: l.rateCardId,
                },
              ],
        ),
        missingFields: [],
      };
    });
  }

  /** POST /invoice-drafts/suggest: the invoice NOLON derives for a shipment; nothing is written. */
  suggest(user: AuthUser, input: InvoiceSuggestRequest): Promise<InvoiceSuggestionDto> {
    return this.invoices.suggestForShipment(user, input);
  }

  /**
   * NOLON's suggestion for the currency and dates an open draft for a shipment misses, for the
   * review screen: worked out on each read by suggestForShipment from the shipment (its customer's
   * currency, the branch's today, the customer's payment terms), with the draft's own currency and
   * invoice date when it has them, so a due date follows the invoice date the draft holds. Only
   * missing values are suggested, and none is saved here: the person applies them through the
   * PATCH (a person's edit at the version shown, which moves the version on), so the request the
   * assistant created under its idempotency key, and its payload hash, never change. Nothing to
   * suggest when the shipment is gone from the reviewer's reach or NOLON cannot derive it.
   */
  async suggestedValues(user: AuthUser, id: string): Promise<InvoiceDraftSuggestedValuesDto> {
    const draft = await this.findScoped(user, id);
    const none = { version: draft.version, values: null, currencySource: null };
    const open = draftStatus(draft.state, draft.expiresAt, new Date()) === 'DRAFT';
    const missing = draft.currency === null || draft.invoiceDate === null || draft.dueDate === null;
    if (!open || draft.shipmentId === null || !missing) return none;
    let suggestion: InvoiceSuggestionDto;
    try {
      suggestion = await this.invoices.suggestForShipment(user, {
        shipmentId: draft.shipmentId,
        ...(draft.currency === null ? {} : { currency: draft.currency }),
        ...(draft.invoiceDate === null ? {} : { invoiceDate: fromDbDate(draft.invoiceDate) }),
      });
    } catch (error) {
      if (isRefusal(error)) return none;
      throw error;
    }
    return {
      version: draft.version,
      values: {
        currency: draft.currency === null ? suggestion.currency : null,
        invoiceDate: draft.invoiceDate === null ? suggestion.invoiceDate : null,
        dueDate: draft.dueDate === null ? suggestion.dueDate : null,
      },
      currencySource: draft.currency === null ? suggestion.currencySource : null,
    };
  }

  /**
   * The checks a draft's values get on create and on a person's edit: once the draft can be
   * priced, a real draft invoice's in full (prepareForShipment), each line without a typed price
   * taking the system price; before, those of the values present. The draft's branch is the
   * shipment's owning branch (which a branch given must be); with no shipment yet, the branch
   * given, one of the user's.
   */
  private async validate(
    user: AuthUser,
    values: InvoiceValues,
    branchId: string | null,
  ): Promise<CheckedInvoice> {
    const ready = priceable(values);
    if (ready !== null) {
      const prepared = await this.invoices.prepareForShipment(user, ready.shipmentId, ready);
      return {
        branchId: draftBranch(user, branchId, prepared.branchId),
        customerId: prepared.customerId,
        currency: prepared.currency,
        lines: prepared.lines.map((l) => ({
          chargeTypeCode: l.chargeTypeCode,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          priceSource: l.priceSource,
          rateCardId: l.rateCardId,
        })),
      };
    }
    const present = await this.invoices.checkPresentForShipment(user, values.shipmentId, values);
    const decimal = (v: string | null | undefined) => (v ? dec(v) : null);
    return {
      branchId: draftBranch(user, branchId, present.branchId),
      customerId: present.customerId,
      currency: present.currency,
      lines: values.lines.map((l) => ({
        chargeTypeCode: l.chargeTypeCode ?? null,
        description: l.description ?? null,
        quantity: decimal(l.quantity),
        unitPrice: decimal(l.unitPrice),
        priceSource: 'TYPED',
        rateCardId: null,
      })),
    };
  }

  async create(
    user: AuthUser,
    body: InvoiceDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, ...rest } = body;
    const { values: input, branchId } = valuesOfCreate(rest);
    const hash = withReplaced(withBranch(invoiceRequestHash(input), branchId), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'invoice_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real draft invoice, on the values present; nothing is written.
    const prepared = await this.validate(user, input, branchId);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'invoice_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'invoice_drafts', scope);
        const existing = await tx.invoiceDraft.findUnique({
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
        const draft = await tx.invoiceDraft.create({
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
        await tx.invoiceDraftLine.createMany({
          data: prepared.lines.map((l, i) => ({ ...l, draftId: draft.id, lineNo: i + 1 })),
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /**
   * A person fills in or changes values of an open draft, at the version they read: the values
   * are checked as on create (a shipment named must be of the draft's branch), and the version
   * moves on. A line kept without a typed price is priced again by NOLON once the draft can be
   * priced. The assistant's request (its payload hash) stays the draft's, so a replay of that
   * create still finds this draft.
   */
  async update(
    user: AuthUser,
    id: string,
    input: InvoiceDraftUpdateRequest,
  ): Promise<InvoiceDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    const stored: InvoiceValues = {
      ...invoiceRequestOf(current),
      // A price NOLON found is found again for the values as they are now; a typed one stays.
      lines: current.lines.map((l) => ({
        chargeTypeCode: l.chargeTypeCode,
        description: l.description,
        quantity: toDecimalStringOrNull(l.quantity),
        unitPrice: l.priceSource === 'TYPED' ? toDecimalStringOrNull(l.unitPrice) : null,
      })),
    };
    const values = patched(stored, patch);
    const checked = await this.validate(user, values, current.branchId);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'invoice_drafts', id);
      if (!locked) throw new NotFoundException('Invoice draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.invoiceDraft.update({
        where: { id },
        data: { ...columnsOf(values, checked), version: { increment: 1 } },
      });
      await tx.invoiceDraftLine.deleteMany({ where: { draftId: id } });
      await tx.invoiceDraftLine.createMany({
        data: checked.lines.map((l, i) => ({ ...l, draftId: id, lineNo: i + 1 })),
      });
    });
    return this.get(user, id);
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.invoiceDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Invoice draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
    page?: ReviewPage,
  ): Promise<InvoiceDraftListItemDto[]> {
    const now = new Date();
    const scope = listScope(user, mine, page);
    const drafts = await this.prisma.invoiceDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...scope.where,
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: scope.take,
    });
    return drafts.map((d) => ({ ...baseFields(d, user, now), lineCount: d.lines.length }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(requester: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    // Only the branches where they may read these records (plan 03, section 5.3).
    const user = withPermissions(requester, 'customer_invoices:view');
    if (user.allowedBranchIds.length === 0) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'invoice',
        d,
        d.invoiceId === null
          ? null
          : {
              type: 'invoice',
              id: d.invoiceId,
              number: d.invoiceNumber,
              path: `/invoices/${d.invoiceId}`,
            },
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<InvoiceDraftDto> {
    return withReplacedBy(this.prisma, 'invoice_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<InvoiceDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return {
      ...baseFields(draft, user, now),
      request: invoiceRequestOf(draft),
      priceSources: draft.lines.map((l): DraftPriceSource => ({
        source: l.priceSource,
        rateCardId: l.rateCardId,
      })),
      check,
      shipmentInvoices:
        draft.shipmentId && draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
          ? await this.invoices.invoicesOfShipment(draft.shipmentId)
          : [],
    };
  }

  /**
   * A person approves the version they reviewed: a DRAFT invoice is created in the same
   * transaction as the approval. Approving an approved draft returns it as it is.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    via: DecisionVia = 'SESSION',
    acknowledgedInvoiceIds: readonly string[] = [],
  ): Promise<InvoiceDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is checked or recorded while the draft misses or holds an invalid value (422).
    requireApprovable(invoiceDraftCompleteness(current));
    const { shipmentId, ...input } = completeInvoice(invoiceRequestOf(current));
    const prepared = await this.invoices.prepareForShipment(user, shipmentId, input);
    await this.prisma.$transaction(async (tx) => {
      let invoiceId = '';
      const decided = await decideInTx(tx, {
        table: 'invoice_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        gate: async () => {
          const row = await tx.invoiceDraft.findUniqueOrThrow({ where: { id }, include: details });
          requireApprovable(invoiceDraftCompleteness(row));
        },
        record: async () => {
          // The shipment's other invoices (Q3): the review screen lists them and the person
          // confirms them; the assistant's chat cannot, so it sends a shipment with invoices there.
          invoiceId = await this.invoices.insertInTx(tx, user, prepared, {
            invoiceIds: acknowledgedInvoiceIds,
            listed: via === 'SESSION',
          });
        },
      });
      if (decided) {
        await tx.invoiceDraft.update({
          where: { id },
          data: { ...approvedFields(user, decidedVia(via)), invoiceId },
        });
      }
    });
    return this.get(user, id);
  }

  /** The draft as the assistant's chat card shows it (erp-agents docs/chat-draft-approval.md). */
  async forAssistant(user: AuthUser, id: string): Promise<AssistantDraftDto<InvoiceDraftDto>> {
    const draft = await this.get(user, id);
    return this.drafts.assistantView(user, 'invoice', 'invoice_drafts', draft, LABEL);
  }

  /** A person approves in the assistant's chat the content the card showed them. */
  async approveFromAssistant(
    user: AuthUser,
    id: string,
    input: AssistantDraftApproveRequest,
  ): Promise<InvoiceDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'invoice',
      'invoice_drafts',
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
  ): Promise<InvoiceDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'invoice',
      'invoice_drafts',
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
  ): Promise<InvoiceDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'invoice_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.invoiceDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason, decidedVia(via)),
      });
    });
    return this.get(user, id);
  }

  /**
   * NOLON's checks of the invoice now, and its total as NOLON rounds it. While the draft misses
   * values, those of the values present: null when they pass (it waits for the rest).
   */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const request = invoiceRequestOf(draft);
    if (invoiceMissingFields(draft).length > 0) {
      const present = await checkDraft(async () => {
        await this.invoices.checkPresentForShipment(user, request.shipmentId, request);
        return { total: null, currency: null };
      });
      return present.ok ? null : present;
    }
    return checkDraft(async () => {
      const { shipmentId, ...input } = completeInvoice(request);
      const prepared = await this.invoices.prepareForShipment(user, shipmentId, input);
      return { total: toDecimalString(prepared.total), currency: prepared.currency };
    });
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.invoiceDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Invoice draft not found');
    return draft;
  }
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.lines.length,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    missingFields: invoiceMissingFields(d),
  };
}

/** The header columns of a draft, a missing value as NULL. */
function columnsOf(values: InvoiceValues, checked: CheckedInvoice) {
  return {
    shipmentId: values.shipmentId ?? null,
    customerId: checked.customerId,
    currency: checked.currency ?? values.currency ?? null,
    invoiceDate: values.invoiceDate ? toDbDate(values.invoiceDate) : null,
    dueDate: values.dueDate ? toDbDate(values.dueDate) : null,
    notes: values.notes ?? null,
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<InvoiceDraftDto, 'request' | 'check' | 'priceSources' | 'shipmentInvoices'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open =
    status === 'DRAFT' && !user.agent && user.access.has('customer_invoices:create', d.branchId);
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    customerId: d.customerId,
    customerName: d.customer?.name ?? null,
    subject: [d.shipment?.number, d.customer?.name].filter(Boolean).join(' · '),
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
    missingFields: invoiceMissingFields(d),
    shipmentNumber: d.shipment?.number ?? null,
    invoiceId: d.invoiceId,
    invoiceNumber: d.invoice?.number ?? null,
  };
}
