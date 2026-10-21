import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateCustomerRequest,
  CustomerDraftCreateRequest,
  CustomerDraftDto,
  CustomerDraftListItemDto,
  CustomerDraftRequest,
  CustomerDraftUpdateRequest,
  DraftEvidence,
  DraftPreCheckDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  NewCustomerBookingDraftCustomer,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { throwFirstConflict } from '../common/rule-issues.js';
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
  type DraftState,
  draftStatus,
  patched,
  preCheck,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
  storedValue,
} from '../drafts/draft-rules.js';
import {
  decideInTx,
  DraftsService,
  keyReused,
  lockDraftRow,
  type LockedReplacement,
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
  type CustomerGate,
  customerCompleteness,
  requireApprovable,
} from '../drafts/draft-completeness.js';
import { CustomersService } from './customers.service.js';

const LABEL = 'customer draft';
const ASSISTANT_ONLY = 'Customer drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a customer draft';

const details = {
  branch: { select: { code: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  customer: { select: { number: true } },
  newCustomerBookingDraft: { select: { id: true } },
} satisfies Prisma.CustomerDraftInclude;

type DraftRow = Prisma.CustomerDraftGetPayload<{ include: typeof details }>;

/** The customer a stored draft proposes. */
export function customerRequestOf(d: DraftRow): CustomerDraftRequest {
  return {
    kind: d.kind,
    name: d.name,
    companyName: d.companyName,
    phone: d.phone,
    whatsapp: d.whatsapp,
    email: d.email,
    city: d.city,
    address: d.address,
    notes: d.notes,
  };
}

/** sha256 of the normalised request and the staff member's words (branch included): ids lower case, absent fields null. */
export function customerRequestHash(
  branchId: string,
  input: CustomerDraftRequest,
  evidence: readonly DraftEvidence[] = [],
): string {
  return requestHash({
    ...evidenceHashPart(evidence),
    branchId: branchId.toLowerCase(),
    kind: input.kind ?? null,
    name: input.name ?? null,
    companyName: input.companyName ?? null,
    phone: input.phone ?? null,
    whatsapp: input.whatsapp ?? null,
    email: input.email ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
  });
}

/** Why a customer draft proposed with a booking cannot be replaced on its own. */
export const PAIRED_REFUSAL =
  'This customer draft goes with an open booking for a new customer: replace the booking for a new customer instead';

/**
 * Whether replacing a customer draft on its own would leave the booking for a new customer it
 * was proposed with waiting for a customer that can no longer be approved: true while that
 * booking draft is open. A decided or expired booking draft waits for nothing.
 */
export function pairedWithOpenBooking(
  booking: { state: DraftState; expiresAt: Date } | null,
  now: Date,
): boolean {
  return booking !== null && draftStatus(booking.state, booking.expiresAt, now) === 'DRAFT';
}

/** The values a customer draft holds, in the shape CustomersService.prepareCreate checks. */
export function presentRequestOf(branchId: string, input: CustomerDraftRequest) {
  return {
    branchId,
    ...input,
    kind: input.kind ?? undefined,
    name: input.name ?? undefined,
    phone: input.phone ?? undefined,
  };
}

/** The customer of a complete draft (the approval gate passed), as CustomersService creates it. */
export function createRequestOf(
  branchId: string,
  input: CustomerDraftRequest,
): CreateCustomerRequest {
  return {
    branchId,
    ...input,
    kind: storedValue(input.kind, 'kind'),
    name: storedValue(input.name, 'name'),
    phone: storedValue(input.phone, 'phone'),
  };
}

/** What a customer draft still misses before it can be approved (the gate's missing values). */
export function customerMissingFields(input: CustomerDraftRequest): string[] {
  return customerCompleteness(input).missing;
}

/** The value columns of a draft, a missing value as NULL. */
function columnsOf(input: CustomerDraftRequest) {
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

/**
 * New customers proposed by the staff AI assistant (entry drafts, src/drafts), so a booking or a
 * quotation can follow for someone not in NOLON yet. A person approves a draft on the review
 * screen, which creates the customer through CustomersService in the same transaction, with
 * their permissions and branches (a phone or tax number taken in the branch is checked under the
 * branch's customer lock); or rejects it. Drafts are branch-owned like customers. There is no
 * decision from the assistant's chat: a customer is master data a person reads in full first.
 */
@Injectable()
export class CustomerDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly drafts: DraftsService,
  ) {}

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: CustomerDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { branchId, evidence = [], ...input } = valuesOf(body);
    return preCheck(customerRequestHash(branchId, input, evidence), async () => {
      // As an approval would: a customer with this phone in the branch refuses it.
      assertBranchAccess(user, branchId);
      await this.customers.prepareCreate(user, presentRequestOf(branchId, input));
      throwFirstConflict(
        await this.customers.duplicateIssues(
          this.prisma,
          [{ branchId, phone: input.phone ?? undefined }],
          user,
        ),
      );
      return { total: null, currency: null, missingFields: customerMissingFields(input) };
    });
  }

  async create(
    user: AuthUser,
    body: CustomerDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, branchId, evidence = [], ...input } = body;
    const hash = withReplaced(customerRequestHash(branchId, input, evidence), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'customer_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real create that need no lock, on the values present; nothing is written.
    await this.customers.prepareCreate(user, presentRequestOf(branchId, input));
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'customer_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'customer_drafts', scope);
        const existing = await tx.customerDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // The user holds the branch now, as stored (not only as their request loaded it).
        await requireBranchMemberInTx(tx, user, branchId);
        if (replaced) await requireUnpaired(tx, replaced.id);
        return this.insertNewInTx(tx, {
          user,
          scope,
          hash,
          branchId,
          input,
          evidence,
          replacesDraftId,
          replaced,
        });
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /**
   * The checks a new customer draft passes before any lock, for a caller that creates one inside
   * its own transaction (createInTx): the branch is the user's, the references exist.
   */
  async prepareNew(user: AuthUser, branchId: string, input: CustomerDraftRequest): Promise<void> {
    await this.customers.prepareCreate(user, presentRequestOf(branchId, input));
  }

  /**
   * A pre-check's duplicate rule for a new customer proposed with another draft: the 409 that
   * createInTx gives for a phone already taken in the branch, at `field` (the phone's path in the
   * combined request). Reads only.
   */
  async requirePhoneFree(
    user: AuthUser,
    branchId: string,
    phone: string,
    field: string,
  ): Promise<void> {
    const [issue] = (
      await this.customers.duplicateIssues(this.prisma, [{ branchId, phone }], user)
    ).flat();
    if (issue) {
      throw new ConflictException({
        message: issue.message,
        fields: [field],
        error: 'Conflict',
        statusCode: 409,
      });
    }
  }

  /**
   * Creates a customer draft in the caller's transaction (a booking for a new customer, proposed
   * in one request with it); its id. The caller ran prepareNew and answered a replay of its own
   * request first, so the key is new here: one a customer draft already holds is refused as
   * reused. A phone already taken in the branch is refused (409), as on create. `replaced` is the
   * customer draft of the pair the caller replaces, locked by the caller (lockReplacedInTx): it is
   * closed as replaced here, and the new draft names it.
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    spec: {
      agentClientId: string;
      idempotencyKey: string;
      branchId: string;
      input: CustomerDraftRequest;
      evidence: readonly DraftEvidence[];
      replaced?: LockedReplacement | null;
    },
  ): Promise<string> {
    const { agentClientId, idempotencyKey, branchId, input, evidence } = spec;
    const replaced = spec.replaced ?? null;
    const replacesDraftId = replaced?.id ?? null;
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    await lockKeyInTx(tx, 'customer_drafts', scope);
    const existing = await tx.customerDraft.findUnique({
      where: { agentClientId_createdById_idempotencyKey: scope },
      select: { id: true },
    });
    if (existing) throw keyReused();
    return this.insertNewInTx(tx, {
      user,
      scope,
      hash: withReplaced(customerRequestHash(branchId, input, evidence), replacesDraftId),
      branchId,
      input,
      evidence,
      replacesDraftId,
      replaced,
    });
  }

  /**
   * The values the approval gate (draft-completeness.ts) reads of a customer draft, through
   * `client` (a transaction holding a lock on a draft linked to it, or the plain client): the
   * customer part of a booking for a new customer.
   */
  gateValuesOf(id: string, client: Prisma.TransactionClient = this.prisma): Promise<CustomerGate> {
    return client.customerDraft.findUniqueOrThrow({
      where: { id },
      select: { kind: true, name: true, phone: true },
    });
  }

  /** gateValuesOf for many customer drafts at once (a list of bookings for new customers), by id. */
  async gateValuesOfMany(ids: readonly string[]): Promise<Map<string, CustomerGate>> {
    const drafts = await this.prisma.customerDraft.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, kind: true, name: true, phone: true },
    });
    return new Map(drafts.map(({ id, ...gate }) => [id, gate]));
  }

  /**
   * The customer drafts a booking for a new customer waits for, by id, as its review screen shows
   * them. The caller read the booking drafts through their own branch scope; a customer draft is
   * in the same branch as its booking draft.
   */
  async linkedOf(ids: readonly string[]): Promise<Map<string, NewCustomerBookingDraftCustomer>> {
    const now = new Date();
    const drafts = await this.prisma.customerDraft.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: {
        id: true,
        state: true,
        expiresAt: true,
        name: true,
        phone: true,
        customerId: true,
        customer: { select: { number: true } },
      },
    });
    return new Map(
      drafts.map((d) => [
        d.id,
        {
          draftId: d.id,
          status: draftStatus(d.state, d.expiresAt, now),
          // Null while the customer draft misses them.
          name: d.name,
          phone: d.phone,
          customerId: d.customerId,
          customerNumber: d.customer?.number ?? null,
        },
      ]),
    );
  }

  /**
   * The checks before a person approves a customer draft together with the booking for a new
   * customer it was proposed with (one step, from the booking's review screen), that need no
   * lock: as `approve` would, at the customer draft's version they reviewed, with each of its
   * values ticked against the staff member's words. The customer to create; nothing is written.
   */
  async prepareLinkedApproval(
    user: AuthUser,
    id: string,
    version: number,
    confirmed: readonly string[],
  ): Promise<CreateCustomerRequest> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    requireOpen(current, version, LABEL);
    requireApprovable(customerCompleteness(customerRequestOf(current)));
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const request = createRequestOf(current.branchId, customerRequestOf(current));
    await this.customers.prepareCreate(user, request);
    return request;
  }

  /**
   * Approves a customer draft inside the approval of its booking for a new customer, after the
   * caller locked the booking draft (the lock order of every path that locks both: the booking
   * draft, then its customer draft). Locks the customer draft, which must still be open at the
   * version reviewed, runs the gate again on the row as locked and creates the customer (a phone
   * taken since is a 409 under the branch's customer lock); the customer's id. A customer draft
   * approved meanwhile on its own screen is used as it is, as the two-step path would.
   */
  async approveLinkedInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    id: string,
    version: number,
    request: CreateCustomerRequest,
  ): Promise<string> {
    const locked = await lockDraftRow(tx, 'customer_drafts', id);
    if (!locked) throw new NotFoundException('Customer draft not found');
    const row = await tx.customerDraft.findUniqueOrThrow({ where: { id }, include: details });
    if (locked.state === 'APPROVED' && row.customerId !== null) return row.customerId;
    requireOpen(locked, version, LABEL);
    requireApprovable(customerCompleteness(customerRequestOf(row)));
    const customerId = (await this.customers.createInTx(tx, user, request)).id;
    await tx.customerDraft.update({
      where: { id },
      data: { ...approvedFields(user), customerId },
    });
    return customerId;
  }

  /** A new request's draft: the phone is free in the branch, the replaced draft is closed. */
  private async insertNewInTx(
    tx: Prisma.TransactionClient,
    spec: {
      user: AuthUser;
      scope: { agentClientId: string; createdById: string; idempotencyKey: string };
      hash: string;
      branchId: string;
      input: CustomerDraftRequest;
      evidence: readonly DraftEvidence[];
      replacesDraftId: string | null;
      replaced: LockedReplacement | null;
    },
  ): Promise<string> {
    const { scope, hash, branchId, input, evidence, replacesDraftId, replaced } = spec;
    // Only a new request: a phone already taken is refused (409), so the assistant can say so
    // instead of proposing a duplicate; it is checked again under the lock on approval. A
    // replay is answered before this, even after its own approval took the phone.
    throwFirstConflict(
      await this.customers.duplicateIssues(
        tx,
        [{ branchId, phone: input.phone ?? undefined }],
        spec.user,
      ),
    );
    if (replaced) await replaceInTx(tx, replaced);
    const draft = await tx.customerDraft.create({
      data: {
        ...scope,
        replacesDraftId,
        branchId,
        expiresAt: draftExpiry(),
        payloadHash: hash,
        evidence: evidence.map((e) => ({ field: e.field, quote: e.quote })),
        ...columnsOf(input),
      },
      select: { id: true },
    });
    return draft.id;
  }

  /**
   * A person fills in or changes values of an open draft, at the version they read: the values
   * are checked as on create (a phone already taken in the branch is refused, 409), and the
   * version moves on. The words of a value the person changed are dropped. The assistant's
   * request (its payload hash) stays the draft's, so a replay of that create still finds it.
   */
  async update(
    user: AuthUser,
    id: string,
    input: CustomerDraftUpdateRequest,
  ): Promise<CustomerDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    const values = patched(customerRequestOf(current), patch);
    await this.customers.prepareCreate(user, presentRequestOf(current.branchId, values));
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'customer_drafts', id);
      if (!locked) throw new NotFoundException('Customer draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      if (patch.phone) {
        throwFirstConflict(
          await this.customers.duplicateIssues(
            tx,
            [{ branchId: current.branchId, phone: patch.phone }],
            user,
          ),
        );
      }
      await tx.customerDraft.update({
        where: { id },
        data: {
          ...columnsOf(values),
          evidence: evidenceAfterEdit(current.evidence, changedFields(patch)),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.customerDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Customer draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
    page?: ReviewPage,
    hidePaired = false,
  ): Promise<CustomerDraftListItemDto[]> {
    const now = new Date();
    const scope = listScope(user, mine, page);
    const drafts = await this.prisma.customerDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...scope.where,
        ...(hidePaired && reviewsWithBooking(user) ? notPairedWithOpenBooking(now) : {}),
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: scope.take,
    });
    return drafts.map((d) => ({ ...baseFields(d, user, now), lineCount: 1, phone: d.phone }));
  }

  /**
   * The "new customers" review list (and the reviewers' "everything waiting" list): as `list`,
   * without the customer drafts this reviewer approves together with their booking for a new
   * customer while that booking draft is open (approveLinkedInTx). Never used for "my drafts".
   */
  listForReview(
    user: AuthUser,
    status?: DraftStatus,
    page?: ReviewPage,
  ): Promise<CustomerDraftListItemDto[]> {
    return this.list(user, status, undefined, page, true);
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('customers:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'customer',
        d,
        d.customerId === null
          ? null
          : {
              type: 'customer',
              id: d.customerId,
              number: d.customerNumber,
              path: `/customers/${d.customerId}`,
            },
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<CustomerDraftDto> {
    return withReplacedBy(this.prisma, 'customer_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<CustomerDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    return {
      ...baseFields(draft, user, now),
      request: customerRequestOf(draft),
      evidence: evidenceOf(draft.evidence),
      check,
    };
  }

  /**
   * A person approves the version they reviewed: the customer is created in the same transaction
   * as the approval. Approving an approved draft returns it as it is.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    confirmed: readonly string[] = [],
  ): Promise<CustomerDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is checked or recorded while the draft misses or holds an invalid value (422).
    requireApprovable(customerCompleteness(customerRequestOf(current)));
    // Each value ticked against the staff member's words on the review screen.
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    const request = createRequestOf(current.branchId, customerRequestOf(current));
    await this.customers.prepareCreate(user, request);
    await this.prisma.$transaction(async (tx) => {
      let customerId = '';
      const decided = await decideInTx(tx, {
        table: 'customer_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        gate: async () => {
          const row = await tx.customerDraft.findUniqueOrThrow({ where: { id }, include: details });
          requireApprovable(customerCompleteness(customerRequestOf(row)));
        },
        record: async () => {
          customerId = (await this.customers.createInTx(tx, user, request)).id;
        },
      });
      if (decided) {
        await tx.customerDraft.update({
          where: { id },
          data: { ...approvedFields(user), customerId },
        });
      }
    });
    return this.get(user, id);
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<CustomerDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'customer_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.customerDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason),
      });
    });
    return this.get(user, id);
  }

  /**
   * NOLON's checks of a create, the phone included (binding only under the lock, on approval),
   * on the values present. Null while the draft misses values and those present pass: it waits
   * for them (missingFields).
   */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const result = await checkDraft(async () => {
      assertBranchAccess(user, draft.branchId);
      await this.customers.prepareCreate(
        user,
        presentRequestOf(draft.branchId, customerRequestOf(draft)),
      );
      throwFirstConflict(
        await this.customers.duplicateIssues(
          this.prisma,
          [{ branchId: draft.branchId, phone: draft.phone ?? undefined }],
          user,
        ),
      );
      return { total: null, currency: null };
    });
    const missing = customerMissingFields(customerRequestOf(draft)).length > 0;
    return result.ok && missing ? null : result;
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.customerDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Customer draft not found');
    return draft;
  }
}

/**
 * Whether this reviewer approves a customer draft proposed with a booking for a new customer from
 * the booking's review screen, in one step: they see and decide the booking draft and may add the
 * customer. A reviewer who cannot keeps the customer draft in their own list (the two-step path:
 * the customer first, then someone who books approves the booking), so it never goes unreviewed.
 */
export function reviewsWithBooking(user: AuthUser): boolean {
  return (
    !user.agent &&
    user.permissions.has('bookings:view') &&
    user.permissions.has('bookings:create') &&
    user.permissions.has('customers:create')
  );
}

/**
 * Customer drafts not waiting on an open booking draft for a new customer (pairedWithOpenBooking):
 * one whose booking draft was rejected, approved or expired is listed again for its own review.
 */
export function notPairedWithOpenBooking(now: Date): Prisma.CustomerDraftWhereInput {
  return { NOT: { newCustomerBookingDraft: { is: { state: 'DRAFT', expiresAt: { gt: now } } } } };
}

/**
 * A customer draft proposed with an open booking for a new customer is replaced with its booking
 * (POST /new-customer-booking-drafts), never alone: the booking draft would be left waiting for a
 * customer that can no longer be approved. The link is read from this side (the booking draft
 * names its customer draft); the caller holds the customer draft's lock, and a booking draft
 * only ever goes from open to decided, so a refusal is never stale in the unsafe direction.
 */
async function requireUnpaired(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const row = await tx.customerDraft.findUnique({
    where: { id },
    select: { newCustomerBookingDraft: { select: { state: true, expiresAt: true } } },
  });
  if (pairedWithOpenBooking(row?.newCustomerBookingDraft ?? null, new Date())) {
    throw new ConflictException(PAIRED_REFUSAL);
  }
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: 1,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    missingFields: customerMissingFields(customerRequestOf(d)),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<CustomerDraftDto, 'request' | 'check' | 'evidence'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('customers:create');
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: d.name ?? '',
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
    missingFields: customerMissingFields(customerRequestOf(d)),
    branchCode: d.branch.code,
    customerId: d.customerId,
    customerNumber: d.customer?.number ?? null,
    bookingDraftId: d.newCustomerBookingDraft?.id ?? null,
  };
}
