import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CUSTOMER_KINDS,
  type CustomerDraftRequest,
  type DraftEvidence,
  type DraftPreCheckDto,
  type DraftPriceSource,
  type DraftStatus,
  type EntryDraftCheck,
  NEW_CUSTOMER_QUOTATION_CUSTOMER_FIELDS,
  type NewCustomerQuotationDraftCreateRequest,
  type NewCustomerQuotationDraftDto,
  type NewCustomerQuotationDraftListItemDto,
  type NewCustomerQuotationDraftSummaryDto,
  type NewCustomerQuotationDraftUpdateRequest,
  type QuotationDraftPricing,
  type QuotationDraftQuotation,
  type QuotationInput,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { toDecimalString } from '../common/money.js';
import { throwFirstConflict } from '../common/rule-issues.js';
import {
  createRequestOf,
  customerRequestHash,
  presentRequestOf,
} from '../customers/customer-drafts.service.js';
import { CustomersService } from '../customers/customers.service.js';
import {
  changedFields,
  evidenceAfterEdit,
  evidenceHashPart,
  evidenceOf,
  requireConfirmed,
} from '../drafts/draft-evidence.js';
import {
  approvedFields,
  checkDraft,
  draftExpiry,
  draftStatus,
  isRefusal,
  patched,
  preCheck,
  rejectedFields,
  requestHash,
  requireOpen,
  resolvedKey,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  decideInTx,
  DraftsService,
  keyReused,
  lockDraftRow,
  lockKeyInTx,
  MY_DRAFTS_ORDER,
  lockReplacedInTx,
  mineWhere,
  myDraftItem,
  type MyDraftRow,
  type MyDraftsQuery,
  replaceInTx,
  storedDraftUnderKey,
  valuesOf,
  withReplaced,
  withReplacedBy,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type Completeness,
  newCustomerQuotationCompleteness,
  quotationValuesCompleteness,
  requireApprovable,
} from '../drafts/draft-completeness.js';
import {
  completeQuotationInput,
  draftLines,
  normalisedDraftQuotation,
  normalisedQuotation,
  pricingOf,
  quotationColumnsOf,
  quotationValuesOf,
  sourcesOf,
} from './quotation-drafts.service.js';
import { QuotationsService } from './quotations.service.js';

const LABEL = 'new customer quotation draft';
const ASSISTANT_ONLY = 'Quotations for a new customer are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a quotation for a new customer';
const TABLE = 'new_customer_quotation_drafts';

const details = {
  lines: { orderBy: { lineNo: 'asc' } },
  branch: { select: { code: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  createdCustomer: { select: { number: true } },
  quotation: { select: { number: true } },
} satisfies Prisma.NewCustomerQuotationDraftInclude;

type DraftRow = Prisma.NewCustomerQuotationDraftGetPayload<{ include: typeof details }>;

type PreparedQuotation = Awaited<ReturnType<QuotationsService['prepareForNewCustomer']>>;

/** The two parts of a new customer quotation draft, each value possibly missing (null). */
export interface NewCustomerQuotationValues {
  customer: CustomerDraftRequest;
  quotation: QuotationDraftQuotation;
}

/** The values a stored draft holds, exactly as stored. */
function valuesOfRow(d: DraftRow): NewCustomerQuotationValues {
  return { customer: customerOf(d), quotation: quotationValuesOf(d) };
}

/** A create body's values (a part left out holds nothing yet), its branch and its words. */
function valuesOfCreate(body: Omit<NewCustomerQuotationDraftCreateRequest, 'idempotencyKey'>): {
  branchId: string;
  values: NewCustomerQuotationValues;
  evidence: DraftEvidence[];
} {
  const { branchId, customer = {}, quotation = {}, evidence = [] } = body;
  return {
    branchId,
    values: { customer, quotation: { ...quotation, lines: quotation.lines ?? [] } },
    evidence,
  };
}

/**
 * A new customer quotation draft's approval gate (draft-completeness.ts), on both parts: the
 * customer (`customer.name`...) and the quotation (`quotation.currency`...).
 */
export function newCustomerQuotationDraftCompleteness(d: DraftRow): Completeness {
  return newCustomerQuotationCompleteness(valuesOfRow(d));
}

/** What the draft still misses before it can be approved (the gate's missing values). */
export function newCustomerQuotationMissingFields(values: NewCustomerQuotationValues): string[] {
  return newCustomerQuotationCompleteness(values).missing;
}

const CUSTOMER_FIELDS: readonly string[] = NEW_CUSTOMER_QUOTATION_CUSTOMER_FIELDS;

/**
 * The staff member's words split: the customer's and the quotation's. Both stay on this draft;
 * the split only keeps the customer's words hashed as a customer draft hashes them.
 */
export function splitEvidence(evidence: readonly DraftEvidence[]): {
  customer: DraftEvidence[];
  quotation: DraftEvidence[];
} {
  const words = evidence.map((e) => ({ field: e.field, quote: e.quote }));
  return {
    customer: words.filter((e) => CUSTOMER_FIELDS.includes(e.field)),
    quotation: words.filter((e) => !CUSTOMER_FIELDS.includes(e.field)),
  };
}

/** The customer as the draft stores it (a JSON object): absent fields null. */
export function storedCustomer(input: CustomerDraftRequest): CustomerDraftRequest {
  return {
    kind: input.kind ?? null,
    name: input.name ?? null,
    companyName: input.companyName ?? null,
    phone: input.phone ?? null,
    whatsapp: input.whatsapp ?? null,
    email: input.email ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
  };
}

const storedCustomerShape = z.object({
  kind: z.enum(CUSTOMER_KINDS).nullable(),
  name: z.string().nullable(),
  companyName: z.string().nullable(),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  email: z.string().nullable(),
  city: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
});

/** The new customer a stored draft proposes (none stored: every value missing). */
export function customerOf(d: { id: string; customer: Prisma.JsonValue }): CustomerDraftRequest {
  if (d.customer === null) return storedCustomer({});
  const parsed = storedCustomerShape.safeParse(d.customer);
  if (!parsed.success) {
    throw new Error(`New customer quotation draft ${d.id} has no valid customer`);
  }
  return parsed.data;
}

/**
 * sha256 of the whole request: the branch, the customer with its words (as a customer draft
 * hashes them), the quotation normalised as a quotation draft hashes it, and its words. A complete
 * quotation hashes as it always did; one missing values in its own form, never equal to it.
 */
export function newCustomerQuotationHash(
  branchId: string,
  values: NewCustomerQuotationValues,
  evidence: readonly DraftEvidence[] = [],
): string {
  const words = splitEvidence(evidence);
  const { customer, quotation } = values;
  return requestHash({
    ...evidenceHashPart(words.quotation),
    kind: 'NEW_CUSTOMER_QUOTATION',
    branchId: branchId.toLowerCase(),
    customer: customerRequestHash(branchId, customer, words.customer),
    quotation:
      quotationValuesCompleteness(quotation).missing.length === 0
        ? normalisedQuotation(completeQuotationInput(quotation))
        : normalisedDraftQuotation(quotation),
  });
}

/**
 * A refusal of the quotation names its fields under `quotation` (`quotation.lines.0.unitPrice`),
 * their paths in this kind's request; any other error passes unchanged.
 */
export async function underQuotation<T>(check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    const response = error.getResponse();
    if (typeof response !== 'object' || response === null) throw error;
    const body = response as Record<string, unknown>;
    if (!Array.isArray(body.fields)) throw error;
    throw new BadRequestException({
      ...body,
      fields: body.fields.map((f) => `quotation.${String(f)}`),
    });
  }
}

/**
 * Quotations proposed by the staff AI assistant for a customer not in NOLON yet (entry drafts,
 * src/drafts). One request creates this draft, holding the new customer and the quotation; there
 * is no customer draft of its own. A person approves it on the review screen only: in one
 * transaction the customer is created through CustomersService (its phone checked again under the
 * branch's customer lock) and an ordinary DRAFT quotation for it through QuotationsService, priced
 * by NOLON (a line with no rate card and no price takes the system price), with the person's
 * permissions and branches. Drafts are branch-owned like the customer. There is no decision from
 * the assistant's chat: a customer is master data a person reads in full first.
 */
@Injectable()
export class NewCustomerQuotationDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotations: QuotationsService,
    private readonly customers: CustomersService,
    private readonly drafts: DraftsService,
  ) {}

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(
    user: AuthUser,
    body: NewCustomerQuotationDraftCreateRequest,
  ): Promise<DraftPreCheckDto> {
    const { branchId, values, evidence } = valuesOfCreate(valuesOf(body));
    return preCheck(newCustomerQuotationHash(branchId, values, evidence), async () => {
      const missingFields = newCustomerQuotationMissingFields(values);
      const prepared = await this.validate(user, branchId, values);
      // As a new request: a customer with this phone in the branch refuses it, at its field.
      const [taken] = (
        await this.customers.duplicateIssues(this.prisma, [
          { branchId, phone: values.customer.phone ?? undefined },
        ])
      ).flat();
      if (taken) {
        throw new ConflictException({
          message: taken.message,
          fields: ['customer.phone'],
          error: 'Conflict',
          statusCode: 409,
        });
      }
      if (prepared === null) return { total: null, currency: null, missingFields };
      const { quotation } = values;
      return {
        total: toDecimalString(prepared.header.total),
        currency: quotation.currency ?? null,
        priceSources: sourcesOf(prepared),
        // A line given no price takes the rate card's: what an approval would record now.
        computed: prepared.lines.flatMap((l, i) =>
          l.rateCardId === null || quotation.lines[i]?.unitPrice !== undefined
            ? []
            : [
                {
                  field: `quotation.lines.${i}.unitPrice`,
                  value: toDecimalString(l.unitPrice),
                  source: 'RATE_CARD' as const,
                  rateCardId: l.rateCardId,
                },
              ],
        ),
        missingFields,
      };
    });
  }

  /**
   * `replacesDraftId` names an earlier draft of this kind the person asked the assistant to
   * change: in the same transaction as the new draft, it is closed as replaced, and the new draft
   * names it.
   */
  async create(
    user: AuthUser,
    body: NewCustomerQuotationDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<NewCustomerQuotationDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    // The route asks for both; kept here so the rule holds if the route ever changes.
    if (!user.permissions.has('customers:create')) {
      throw new ForbiddenException('Proposing a new customer needs permission to add customers');
    }
    const { idempotencyKey, ...rest } = body;
    const { branchId, values, evidence } = valuesOfCreate(rest);
    const { customer, quotation } = values;
    const hash = withReplaced(
      newCustomerQuotationHash(branchId, values, evidence),
      replacesDraftId,
    );
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, TABLE, scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real create that need no lock, for both parts (those of the values present
    // while values are missing); nothing is written.
    await this.validate(user, branchId, values);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: TABLE,
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'new_customer_quotation_drafts', scope);
        const existing = await tx.newCustomerQuotationDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // The user holds the branch now, as stored (not only as their request loaded it).
        await requireBranchMemberInTx(tx, user, branchId);
        // Only a new request: a phone already taken in the branch is refused (409), so the
        // assistant can say so instead of proposing a duplicate; it is checked again under the
        // lock on approval.
        throwFirstConflict(
          await this.customers.duplicateIssues(tx, [
            { branchId, phone: customer.phone ?? undefined },
          ]),
        );
        if (replaced) await replaceInTx(tx, replaced);
        const draft = await tx.newCustomerQuotationDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            evidence: evidence.map((e) => ({ field: e.field, quote: e.quote })),
            customer: { ...storedCustomer(customer) },
            ...quotationColumnsOf(quotation),
          },
          select: { id: true },
        });
        await tx.newCustomerQuotationDraftLine.createMany({
          data: draftLines(quotation.lines).map((line) => ({ ...line, draftId: draft.id })),
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /**
   * A person fills in or changes values of an open draft, at the version they read: the values
   * are checked as on create, a phone given is refused when a customer of the branch holds it, a
   * changed value's words go (the person's now), and the version moves on (a pricing shown before
   * no longer applies). The assistant's request (its payload hash) stays the draft's.
   */
  async update(
    user: AuthUser,
    id: string,
    input: NewCustomerQuotationDraftUpdateRequest,
  ): Promise<NewCustomerQuotationDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, customer: customerPatch = {}, quotation: quotationPatch = {} } = input;
    requireOpen(current, version, LABEL);
    const stored = valuesOfRow(current);
    const values = {
      customer: patched(stored.customer, customerPatch),
      quotation: patched(stored.quotation, quotationPatch),
    };
    // The draft's branch stays: a draft never changes branch.
    await this.validate(user, current.branchId, values);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, TABLE, id);
      if (!locked) throw new NotFoundException('New customer quotation draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      if (customerPatch.phone) {
        throwFirstConflict(
          await this.customers.duplicateIssues(tx, [
            { branchId: current.branchId, phone: customerPatch.phone },
          ]),
        );
      }
      await tx.newCustomerQuotationDraft.update({
        where: { id },
        data: {
          customer: { ...storedCustomer(values.customer) },
          ...quotationColumnsOf(values.quotation),
          evidence: evidenceAfterEdit(current.evidence, [
            ...changedFields(customerPatch),
            ...changedFields(quotationPatch),
          ]),
          version: { increment: 1 },
        },
      });
      if (quotationPatch.lines !== undefined) {
        await tx.newCustomerQuotationDraftLine.deleteMany({ where: { draftId: id } });
        await tx.newCustomerQuotationDraftLine.createMany({
          data: draftLines(values.quotation.lines).map((line) => ({ ...line, draftId: id })),
        });
      }
    });
    return this.get(user, id);
  }

  async findByKey(
    user: AuthUser,
    idempotencyKey: string,
  ): Promise<NewCustomerQuotationDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.newCustomerQuotationDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('New customer quotation draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
  ): Promise<NewCustomerQuotationDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.newCustomerQuotationDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...(mine ? mineWhere(user, mine) : {}),
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: mine?.limit ?? 200,
    });
    return drafts.map((d) => ({
      ...baseFields(d, user, now),
      lineCount: d.lines.length,
      phone: customerOf(d).phone ?? null,
    }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('quotations:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'new_customer_quotation',
        d,
        d.quotationId === null
          ? null
          : {
              type: 'quotation',
              id: d.quotationId,
              number: d.quotationNumber,
              path: `/quotations/${d.quotationId}`,
            },
      ),
    );
  }

  /** The draft, with whether NOLON would accept it now (checked, nothing written). */
  async get(user: AuthUser, id: string): Promise<NewCustomerQuotationDraftDto> {
    return withReplacedBy(this.prisma, TABLE, await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<NewCustomerQuotationDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const { check, pricing, priceSources } =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.priced(user, draft)
        : { check: null, pricing: null, priceSources: null };
    return {
      ...baseFields(draft, user, now),
      customer: customerOf(draft),
      request: quotationValuesOf(draft),
      evidence: evidenceOf(draft.evidence),
      check,
      pricing,
      priceSources,
    };
  }

  /**
   * A person approves the version they reviewed, with the prices they reviewed (`pricingKey`) and
   * each value ticked against the staff member's words: the customer and the DRAFT quotation for
   * it are created in the same transaction as the approval. Approving an approved draft returns
   * it as it is, without a second customer or quotation.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    pricingKey: string,
    confirmed: readonly string[] = [],
  ): Promise<NewCustomerQuotationDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is checked, priced or recorded while the customer or the quotation misses or holds
    // an invalid value (422).
    requireApprovable(newCustomerQuotationDraftCompleteness(current));
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const customer = createRequestOf(current.branchId, customerOf(current));
    // The request is the one at `version`; the lock below refuses if it changed since.
    const prepared = await this.prepareNew(
      user,
      current.branchId,
      customerOf(current),
      completeQuotationInput(quotationValuesOf(current)),
    );
    // Exactly the prices the person reviewed (rate cards resolved); this same `prepared` is what
    // is inserted. Anything else asks for a reload.
    this.drafts.requireResolved('SESSION', resolvedKey(prepared), LABEL, pricingKey);
    await this.prisma.$transaction(async (tx) => {
      let customerId = '';
      let quotationId = '';
      const decided = await decideInTx(tx, {
        table: TABLE,
        id,
        version,
        label: LABEL,
        approving: true,
        gate: async () => {
          const row = await tx.newCustomerQuotationDraft.findUniqueOrThrow({
            where: { id },
            include: details,
          });
          requireApprovable(newCustomerQuotationDraftCompleteness(row));
        },
        record: async () => {
          // Under the branch's customer lock: a phone taken since the create is a 409 here.
          customerId = (await this.customers.createInTx(tx, user, customer)).id;
          quotationId = (await this.quotations.insertInTx(tx, user, { ...prepared, customerId }))
            .id;
        },
      });
      if (decided) {
        await tx.newCustomerQuotationDraft.update({
          where: { id },
          data: { ...approvedFields(user), customerId, quotationId },
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<NewCustomerQuotationDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: TABLE,
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.newCustomerQuotationDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason),
      });
    });
    return this.get(user, id);
  }

  /**
   * The checks of both parts that need no lock: the customer (branch of the user's, references)
   * and the quotation priced in that branch (route, currency, rates, system prices, valid-until).
   */
  private async prepareNew(
    user: AuthUser,
    branchId: string,
    customer: CustomerDraftRequest,
    quotation: QuotationInput,
  ): Promise<PreparedQuotation> {
    await this.customers.prepareCreate(user, presentRequestOf(branchId, customer));
    return underQuotation(() => this.quotations.prepareForNewCustomer(user, branchId, quotation));
  }

  /**
   * The checks a draft's values get on create and on a person's edit: with the quotation
   * complete, prepareNew's in full (prices included); with values missing, those of the values
   * present (the customer's, the quotation's as a quotation draft's), and no prices (null).
   */
  private async validate(
    user: AuthUser,
    branchId: string,
    values: NewCustomerQuotationValues,
  ): Promise<PreparedQuotation | null> {
    if (quotationValuesCompleteness(values.quotation).missing.length === 0) {
      return this.prepareNew(
        user,
        branchId,
        values.customer,
        completeQuotationInput(values.quotation),
      );
    }
    await this.customers.prepareCreate(user, presentRequestOf(branchId, values.customer));
    await underQuotation(() =>
      this.quotations.checkPresent(user, { ...values.quotation, customerId: null }, branchId),
    );
    return null;
  }

  /**
   * Whether NOLON would accept the draft now (the customer's phone included, binding only under
   * the lock on approval) and, if so, the prices it would record.
   */
  private async priced(
    user: AuthUser,
    draft: DraftRow,
  ): Promise<{
    check: EntryDraftCheck | null;
    pricing: QuotationDraftPricing | null;
    priceSources: DraftPriceSource[] | null;
  }> {
    const values = valuesOfRow(draft);
    const phoneTaken = async () =>
      throwFirstConflict(
        await this.customers.duplicateIssues(this.prisma, [
          { branchId: draft.branchId, phone: values.customer.phone ?? undefined },
        ]),
      );
    if (newCustomerQuotationMissingFields(values).length > 0) {
      // No prices while values are missing; null check while those present pass (missingFields).
      const present = await checkDraft(async () => {
        await this.validate(user, draft.branchId, values);
        await phoneTaken();
        return { total: null, currency: null };
      });
      return { check: present.ok ? null : present, pricing: null, priceSources: null };
    }
    try {
      const prepared = await this.prepareNew(
        user,
        draft.branchId,
        values.customer,
        completeQuotationInput(values.quotation),
      );
      await phoneTaken();
      return {
        check: {
          ok: true,
          total: toDecimalString(prepared.header.total),
          currency: draft.currency,
        },
        pricing: pricingOf(prepared),
        priceSources: sourcesOf(prepared),
      };
    } catch (error) {
      if (isRefusal(error)) {
        return { check: { ok: false, message: error.message }, pricing: null, priceSources: null };
      }
      throw error;
    }
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.newCustomerQuotationDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('New customer quotation draft not found');
    return draft;
  }
}

function toSummary(d: DraftRow, now: Date): NewCustomerQuotationDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.lines.length,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    missingFields: newCustomerQuotationMissingFields(valuesOfRow(d)),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<
  NewCustomerQuotationDraftDto,
  'request' | 'check' | 'evidence' | 'pricing' | 'priceSources' | 'customer'
> {
  const status = draftStatus(d.state, d.expiresAt, now);
  // Approving creates a customer and a quotation: the person needs both permissions.
  const open =
    status === 'DRAFT' &&
    !user.agent &&
    user.permissions.has('quotations:create') &&
    user.permissions.has('customers:create');
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: customerOf(d).name ?? '',
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
    branchCode: d.branch.code,
    customerId: d.customerId,
    customerNumber: d.createdCustomer?.number ?? null,
    quotationId: d.quotationId,
    quotationNumber: d.quotation?.number ?? null,
    missingFields: newCustomerQuotationMissingFields(valuesOfRow(d)),
  };
}
