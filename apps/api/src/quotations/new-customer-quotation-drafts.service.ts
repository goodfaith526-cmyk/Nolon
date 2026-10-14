import {
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CUSTOMER_KINDS,
  type CreateCustomerRequest,
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
  type QuotationDraftPricing,
  type QuotationInput,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { toDbDate } from '../common/dates.js';
import { toDecimalString } from '../common/money.js';
import { throwFirstConflict } from '../common/rule-issues.js';
import { customerRequestHash } from '../customers/customer-drafts.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { evidenceHashPart, evidenceOf, requireConfirmed } from '../drafts/draft-evidence.js';
import {
  approvedFields,
  draftExpiry,
  draftStatus,
  isRefusal,
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
  normalisedQuotation,
  pricingOf,
  quotationInputOf,
  sourcesOf,
  storedLines,
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

/** The customer as the draft stores it (a JSON object): absent optional fields null. */
export function storedCustomer(input: CustomerDraftRequest): CustomerDraftRequest {
  return {
    kind: input.kind,
    name: input.name,
    companyName: input.companyName ?? null,
    phone: input.phone,
    whatsapp: input.whatsapp ?? null,
    email: input.email ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
  };
}

const storedCustomerShape = z.object({
  kind: z.enum(CUSTOMER_KINDS),
  name: z.string(),
  companyName: z.string().nullable(),
  phone: z.string(),
  whatsapp: z.string().nullable(),
  email: z.string().nullable(),
  city: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
});

/** The new customer a stored draft proposes. */
export function customerOf(d: { id: string; customer: Prisma.JsonValue }): CustomerDraftRequest {
  const parsed = storedCustomerShape.safeParse(d.customer);
  if (!parsed.success) {
    throw new Error(`New customer quotation draft ${d.id} has no valid customer`);
  }
  return parsed.data;
}

/**
 * sha256 of the whole request: the branch, the customer with its words (as a customer draft
 * hashes them), the quotation normalised as a quotation draft hashes it, and its words.
 */
export function newCustomerQuotationHash(
  branchId: string,
  customer: CustomerDraftRequest,
  quotation: QuotationInput,
  evidence: readonly DraftEvidence[] = [],
): string {
  const words = splitEvidence(evidence);
  return requestHash({
    ...evidenceHashPart(words.quotation),
    kind: 'NEW_CUSTOMER_QUOTATION',
    branchId: branchId.toLowerCase(),
    customer: customerRequestHash(branchId, customer, words.customer),
    quotation: normalisedQuotation(quotation),
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
    const { branchId, customer, quotation, evidence = [] } = valuesOf(body);
    return preCheck(newCustomerQuotationHash(branchId, customer, quotation, evidence), async () => {
      const prepared = await this.prepareNew(user, branchId, customer, quotation);
      // As a new request: a customer with this phone in the branch refuses it, at its field.
      const [taken] = (
        await this.customers.duplicateIssues(this.prisma, [{ branchId, phone: customer.phone }])
      ).flat();
      if (taken) {
        throw new ConflictException({
          message: taken.message,
          fields: ['customer.phone'],
          error: 'Conflict',
          statusCode: 409,
        });
      }
      return {
        total: toDecimalString(prepared.header.total),
        currency: quotation.currency,
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
    const { idempotencyKey, branchId, customer, quotation, evidence = [] } = body;
    const hash = withReplaced(
      newCustomerQuotationHash(branchId, customer, quotation, evidence),
      replacesDraftId,
    );
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, TABLE, scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real create that need no lock, for both parts; nothing is written.
    await this.prepareNew(user, branchId, customer, quotation);
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
        // Only a new request: a phone already taken in the branch is refused (409), so the
        // assistant can say so instead of proposing a duplicate; it is checked again under the
        // lock on approval.
        throwFirstConflict(
          await this.customers.duplicateIssues(tx, [{ branchId, phone: customer.phone }]),
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
            originLocationId: quotation.originLocationId,
            destinationLocationId: quotation.destinationLocationId,
            mode: quotation.mode,
            loadType: quotation.loadType ?? null,
            cargoType: quotation.cargoType,
            cargoDescription: quotation.cargoDescription ?? null,
            currency: quotation.currency,
            validUntil: toDbDate(quotation.validUntil),
            terms: quotation.terms ?? null,
          },
          select: { id: true },
        });
        await tx.newCustomerQuotationDraftLine.createMany({
          data: storedLines(quotation).map((line) => ({ ...line, draftId: draft.id })),
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
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
      phone: customerOf(d).phone,
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
      request: quotationInputOf(draft),
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
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const customer = createRequestOf(current.branchId, customerOf(current));
    // The request is the one at `version`; the lock below refuses if it changed since.
    const prepared = await this.prepareNew(
      user,
      current.branchId,
      customerOf(current),
      quotationInputOf(current),
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
    await this.customers.prepareCreate(user, createRequestOf(branchId, customer));
    return underQuotation(() => this.quotations.prepareForNewCustomer(user, branchId, quotation));
  }

  /**
   * Whether NOLON would accept the draft now (the customer's phone included, binding only under
   * the lock on approval) and, if so, the prices it would record.
   */
  private async priced(
    user: AuthUser,
    draft: DraftRow,
  ): Promise<{
    check: EntryDraftCheck;
    pricing: QuotationDraftPricing | null;
    priceSources: DraftPriceSource[] | null;
  }> {
    try {
      const customer = customerOf(draft);
      const prepared = await this.prepareNew(
        user,
        draft.branchId,
        customer,
        quotationInputOf(draft),
      );
      throwFirstConflict(
        await this.customers.duplicateIssues(this.prisma, [
          { branchId: draft.branchId, phone: customer.phone },
        ]),
      );
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

function createRequestOf(branchId: string, input: CustomerDraftRequest): CreateCustomerRequest {
  return { branchId, ...input };
}

function toSummary(d: DraftRow, now: Date): NewCustomerQuotationDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.lines.length,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
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
    subject: customerOf(d).name,
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
    branchCode: d.branch.code,
    customerId: d.customerId,
    customerNumber: d.createdCustomer?.number ?? null,
    quotationId: d.quotationId,
    quotationNumber: d.quotation?.number ?? null,
  };
}
