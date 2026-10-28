import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BOOKING_SERVICES,
  CARGO_TYPES,
  type CreateCustomerRequest,
  type CustomerDraftRequest,
  type DraftEvidence,
  type DraftPreCheckDto,
  type DraftStatus,
  type EntryDraftCheck,
  LOAD_TYPES,
  NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS,
  type NewCustomerBookingDraftBooking,
  type NewCustomerBookingDraftCreateRequest,
  type NewCustomerBookingDraftCustomer,
  type NewCustomerBookingDraftDto,
  type NewCustomerBookingDraftListItemDto,
  type NewCustomerBookingDraftSummaryDto,
  type NewCustomerBookingDraftUpdateRequest,
  type NewCustomerBookingRequest,
  SHIPPING_MODES,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { assertBranchAccess, branchScope, withPermissions } from '../auth/branch-scope.js';
import { dec } from '../common/money.js';
import {
  CustomerDraftsService,
  customerRequestHash,
} from '../customers/customer-drafts.service.js';
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
  bookingValuesCompleteness,
  type Completeness,
  type CustomerGate,
  newCustomerBookingCompleteness,
  requireApprovable,
} from '../drafts/draft-completeness.js';
import { BookingsService, type PreparedBooking } from './bookings.service.js';
import { ContainerBookingsRegistry } from './container-bookings.registry.js';

const LABEL = 'new customer booking draft';
const ASSISTANT_ONLY = 'Bookings for a new customer are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a booking for a new customer';
const TABLE = 'new_customer_booking_drafts';
const CUSTOMER_LABEL = 'customer draft';

/** Why a pair whose customer is approved is not replaced by a new pair. */
export const CUSTOMER_APPROVED_REFUSAL =
  'The new customer of this booking is already approved: reject this booking for a new customer in NOLON and propose a normal booking for that customer';
/** Why a pair whose customer draft was rejected or expired is not replaced. */
export const CUSTOMER_CLOSED_REFUSAL =
  'The new customer of this booking is already decided or expired: reject this booking for a new customer in NOLON and propose a new one';

/** Why a one-step approval (the booking with its customer draft) is refused to this user. */
export const CUSTOMER_PERMISSION_REFUSAL =
  'Approving the new customer with the booking needs permission to add customers: have the customer draft approved first, then approve the booking';

/** What an approval records (approvalPlan). */
type ApprovalPlan =
  | { kind: 'READY'; customerId: string }
  | {
      kind: 'WITH_CUSTOMER';
      customer: CreateCustomerRequest;
      customerVersion: number;
      booking: (customerId: string) => PreparedBooking;
    };

interface DraftOpenness {
  state: DraftState;
  expiresAt: Date;
  version: number;
}

/**
 * A booking for a new customer is replaced together with its customer draft, so both must still
 * be open: the booking draft (as for any replaced draft), and the customer draft, since a
 * customer already approved exists in NOLON and a new pair would propose a second one. A conflict
 * otherwise.
 */
export function requireReplaceablePair(
  booking: DraftOpenness,
  customer: DraftOpenness,
  now: Date = new Date(),
): void {
  requireOpen(booking, booking.version, LABEL, now);
  if (customer.state === 'APPROVED') throw new ConflictException(CUSTOMER_APPROVED_REFUSAL);
  if (draftStatus(customer.state, customer.expiresAt, now) !== 'DRAFT') {
    throw new ConflictException(CUSTOMER_CLOSED_REFUSAL);
  }
}

const details = {
  branch: { select: { code: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  booking: { select: { number: true } },
} satisfies Prisma.NewCustomerBookingDraftInclude;

type DraftRow = Prisma.NewCustomerBookingDraftGetPayload<{ include: typeof details }>;

const CUSTOMER_FIELDS: readonly string[] = NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS;

/** The staff member's words split: the customer's go on the customer draft, the rest here. */
export function splitEvidence(evidence: readonly DraftEvidence[]): {
  customer: DraftEvidence[];
  booking: DraftEvidence[];
} {
  const words = evidence.map((e) => ({ field: e.field, quote: e.quote }));
  return {
    customer: words.filter((e) => CUSTOMER_FIELDS.includes(e.field)),
    booking: words.filter((e) => !CUSTOMER_FIELDS.includes(e.field)),
  };
}

/** A measurement as stored and hashed: its canonical decimal string ("1.50" is "1.5"). */
function canonical(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : dec(value).toFixed();
}

/**
 * The booking as the draft stores it (a JSON object): absent fields null (a missing value too),
 * services without repeats, measurements as canonical decimal strings, never numbers. A complete
 * booking is stored, and hashed, exactly as before drafts could miss values.
 */
export function storedRequest(
  input: NewCustomerBookingDraftBooking,
): NewCustomerBookingDraftBooking {
  return {
    originLocationId: input.originLocationId?.toLowerCase() ?? null,
    destinationLocationId: input.destinationLocationId?.toLowerCase() ?? null,
    mode: input.mode ?? null,
    loadType: input.loadType ?? null,
    cargoType: input.cargoType ?? null,
    cargoDescription: input.cargoDescription ?? null,
    services: [...new Set(input.services)],
    requestedDeparture: input.requestedDeparture ?? null,
    specialInstructions: input.specialInstructions ?? null,
    // Only when it names one: a booking without a container is stored and hashed as before.
    ...(input.consolidationId ? { consolidationId: input.consolidationId.toLowerCase() } : {}),
    items: input.items.map((item) => ({
      cargoType: item.cargoType ?? null,
      containerTypeCode: item.containerTypeCode ?? null,
      description: item.description ?? null,
      quantity: item.quantity ?? null,
      weightKg: canonical(item.weightKg),
      volumeCbm: canonical(item.volumeCbm),
    })),
  };
}

const storedShape = z.object({
  originLocationId: z.string().nullable(),
  destinationLocationId: z.string().nullable(),
  mode: z.enum(SHIPPING_MODES).nullable(),
  loadType: z.enum(LOAD_TYPES).nullable(),
  cargoType: z.enum(CARGO_TYPES).nullable(),
  cargoDescription: z.string().nullable(),
  services: z.array(z.enum(BOOKING_SERVICES)),
  requestedDeparture: z.string().nullable(),
  specialInstructions: z.string().nullable(),
  consolidationId: z.string().optional(),
  items: z.array(
    z.object({
      cargoType: z.enum(CARGO_TYPES).nullable(),
      containerTypeCode: z.string().nullable(),
      description: z.string().nullable(),
      quantity: z.number().int().nullable(),
      weightKg: z.string().nullable(),
      volumeCbm: z.string().nullable(),
    }),
  ),
});

/** The booking a stored draft proposes (a missing value null). */
export function bookingRequestOf(d: {
  id: string;
  request: Prisma.JsonValue;
}): NewCustomerBookingDraftBooking {
  const parsed = storedShape.safeParse(d.request);
  if (!parsed.success) throw new Error(`New customer booking draft ${d.id} has no valid booking`);
  return parsed.data;
}

/** Whether the booking part misses no value (its customer apart). */
function bookingComplete(booking: NewCustomerBookingDraftBooking): boolean {
  return bookingValuesCompleteness(booking).missing.length === 0;
}

/** The booking of a complete draft (the approval gate passed), as BookingsService takes it. */
export function completeBookingRequest(
  booking: NewCustomerBookingDraftBooking,
): NewCustomerBookingRequest {
  return {
    ...booking,
    originLocationId: storedValue(booking.originLocationId, 'origin'),
    destinationLocationId: storedValue(booking.destinationLocationId, 'destination'),
    mode: storedValue(booking.mode, 'mode'),
    cargoType: booking.cargoType ?? null,
    items: booking.items.map((item) => ({
      ...item,
      cargoType: storedValue(item.cargoType, 'line cargo type'),
      quantity: storedValue(item.quantity, 'line quantity'),
    })),
  };
}

/** A create body's values: a part left out holds nothing yet (no services, no lines). */
function valuesOfCreate(body: Omit<NewCustomerBookingDraftCreateRequest, 'idempotencyKey'>): {
  branchId: string;
  customer: CustomerDraftRequest;
  booking: NewCustomerBookingDraftBooking;
  evidence: DraftEvidence[];
} {
  const { branchId, customer = {}, booking = {}, evidence = [] } = body;
  return {
    branchId,
    customer,
    booking: { ...booking, services: booking.services ?? [], items: booking.items ?? [] },
    evidence,
  };
}

/** The approval gate's findings on both parts (customer draft's values, the booking's). */
function pairCompleteness(
  customer: CustomerGate,
  booking: NewCustomerBookingDraftBooking,
): Completeness {
  return newCustomerBookingCompleteness({ customer, booking });
}

/**
 * sha256 of the whole request: the branch and the customer with its words (as a customer draft
 * hashes them), the booking normalised as stored (services sorted), and the booking's words.
 */
export function newCustomerBookingHash(
  branchId: string,
  customer: CustomerDraftRequest,
  booking: NewCustomerBookingDraftBooking,
  evidence: readonly DraftEvidence[] = [],
): string {
  const words = splitEvidence(evidence);
  const stored = storedRequest(booking);
  return requestHash({
    ...evidenceHashPart(words.booking),
    kind: 'NEW_CUSTOMER_BOOKING',
    branchId: branchId.toLowerCase(),
    customer: customerRequestHash(branchId, customer, words.customer),
    booking: { ...stored, services: [...stored.services].sort() },
  });
}

/** Why the booking cannot be approved yet, by its customer draft's status; null once approved. */
export function customerNotReady(customer: NewCustomerBookingDraftCustomer): string | null {
  if (customer.status === 'APPROVED' && customer.customerId !== null) return null;
  if (customer.status === 'REJECTED') {
    return 'The new customer was rejected, so this booking cannot be approved';
  }
  if (customer.status === 'EXPIRED') {
    return 'The new customer draft has expired, so this booking cannot be approved';
  }
  return 'Approve the new customer first: a booking needs a customer in NOLON';
}

/**
 * Bookings proposed by the staff AI assistant for a customer not in NOLON yet (entry drafts,
 * src/drafts). One request creates, in one transaction, a customer draft (through
 * CustomerDraftsService, with its own checks and words) and this booking draft, linked. A person
 * approves the customer draft first, on its own review screen; approving this draft then creates
 * an ordinary DRAFT booking for the customer that approval created, through BookingsService with
 * the person's permissions and branches, in the same transaction as the approval. Drafts are
 * branch-owned like the customer. There is no decision from the assistant's chat.
 *
 * A booking that names an open container (`consolidationId`) is booked into it on approval as from
 * the container's page (ContainerBookingsRegistry): recorded, confirmed and its shipment put in the
 * container, under the container's rules for the person approving.
 */
@Injectable()
export class NewCustomerBookingDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly customerDrafts: CustomerDraftsService,
    private readonly drafts: DraftsService,
    private readonly containers: ContainerBookingsRegistry,
  ) {}

  /**
   * `replacesDraftId` names an earlier booking draft of this kind the person asked the assistant
   * to change: in the same transaction as the new pair, that draft and its customer draft are
   * closed as replaced, and the new booking draft and customer draft name them.
   */
  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(
    user: AuthUser,
    body: NewCustomerBookingDraftCreateRequest,
  ): Promise<DraftPreCheckDto> {
    const { branchId, customer, booking, evidence } = valuesOfCreate(valuesOf(body));
    return preCheck(newCustomerBookingHash(branchId, customer, booking, evidence), async () => {
      await this.validate(user, branchId, customer, booking);
      // As the create would: a phone already taken in the branch refuses the pair.
      if (customer.phone) {
        await this.customerDrafts.requirePhoneFree(
          user,
          branchId,
          customer.phone,
          'customer.phone',
        );
      }
      return {
        total: null,
        currency: null,
        missingFields: pairCompleteness(customer, booking).missing,
      };
    });
  }

  /**
   * The checks a pair's values get on create (and the booking's on a person's edit), that need no
   * lock: the customer's values present (customer drafts' own checks); the booking's in full once
   * complete (route, services, lines, the container it fits), else those of the values present
   * (a container named is a reference checked now; whether the booking fits it waits).
   */
  private async validate(
    user: AuthUser,
    branchId: string,
    customer: CustomerDraftRequest | null,
    booking: NewCustomerBookingDraftBooking,
  ): Promise<void> {
    if (customer !== null) await this.customerDrafts.prepareNew(user, branchId, customer);
    else assertBranchAccess(user, branchId);
    if (bookingComplete(booking)) {
      const complete = completeBookingRequest(booking);
      await this.bookings.prepareWithoutCustomer(complete);
      await this.requireContainer(user, complete);
      return;
    }
    await this.bookings.checkPresent(user, { ...booking, customerId: null }, branchId);
    if (booking.consolidationId) {
      await this.containers.get().requireReference(user, booking.consolidationId);
    }
  }

  async create(
    user: AuthUser,
    body: NewCustomerBookingDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<NewCustomerBookingDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, ...rest } = body;
    const { branchId, customer, booking, evidence } = valuesOfCreate(rest);
    // The route asks for bookings:create; the customer part is a customer draft, which needs
    // customers:create of its own, in the draft's branch.
    if (!user.access.has('customers:create', branchId)) {
      throw new ForbiddenException('Proposing a new customer needs permission to add customers');
    }
    const hash = withReplaced(
      newCustomerBookingHash(branchId, customer, booking, evidence),
      replacesDraftId,
    );
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, TABLE, scope, hash);
    if (stored !== null) return this.summary(await this.findScoped(user, stored));
    // The checks of a real create that need no lock, for both parts (those of the values present
    // while values are missing); nothing is written.
    await this.validate(user, branchId, customer, booking);
    const words = splitEvidence(evidence);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedPairInTx(tx, replacesDraftId, agentClientId, user);
        await lockKeyInTx(tx, 'new_customer_booking_drafts', scope);
        const existing = await tx.newCustomerBookingDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // The user holds the branch now, as stored (not only as their request loaded it).
        await requireBranchMemberInTx(tx, user, branchId);
        if (replaced) {
          requireReplaceablePair(replaced.booking, replaced.customer);
          await replaceInTx(tx, replaced.booking);
        }
        // The customer draft under the same key in its own table (a phone taken is a 409 there);
        // it closes the replaced pair's customer draft and names it.
        const customerDraftId = await this.customerDrafts.createInTx(tx, user, {
          agentClientId,
          idempotencyKey,
          branchId,
          input: customer,
          evidence: words.customer,
          replaced: replaced?.customer ?? null,
        });
        const draft = await tx.newCustomerBookingDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId,
            customerDraftId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            evidence: words.booking.map((e) => ({ field: e.field, quote: e.quote })),
            request: { ...storedRequest(booking) },
          },
          select: { id: true },
        });
        return draft.id;
      }),
    );
    return this.summary(await this.findScoped(user, id));
  }

  /**
   * A person fills in or changes the booking's values of an open draft, at the version they read:
   * they are checked as on create, a changed value's words go (the person's now), and the version
   * moves on. The customer is completed on its own customer draft; the branch stays. The
   * assistant's request (its payload hash) stays the draft's.
   */
  async update(
    user: AuthUser,
    id: string,
    input: NewCustomerBookingDraftUpdateRequest,
  ): Promise<NewCustomerBookingDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    const booking = patched(bookingRequestOf(current), patch);
    await this.validate(user, current.branchId, null, booking);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, TABLE, id);
      if (!locked) throw new NotFoundException('New customer booking draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.newCustomerBookingDraft.update({
        where: { id },
        data: {
          request: { ...storedRequest(booking) },
          evidence: evidenceAfterEdit(current.evidence, changedFields(patch)),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  async findByKey(
    user: AuthUser,
    idempotencyKey: string,
  ): Promise<NewCustomerBookingDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.newCustomerBookingDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('New customer booking draft not found');
    return this.summary(draft);
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
    page?: ReviewPage,
  ): Promise<NewCustomerBookingDraftListItemDto[]> {
    const now = new Date();
    const scope = listScope(user, mine, page);
    const drafts = await this.prisma.newCustomerBookingDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...scope.where,
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: scope.take,
    });
    const ids = drafts.map((d) => d.customerDraftId);
    const customers = await this.customerDrafts.linkedOf(ids);
    const gates = await this.customerDrafts.gateValuesOfMany(ids);
    return drafts.map((d) => ({
      ...baseFields(d, linkedCustomer(customers, d), user, now),
      lineCount: bookingRequestOf(d).items.length,
      missingFields: pairCompleteness(gateOf(gates, d), bookingRequestOf(d)).missing,
    }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(requester: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    // Only the branches where they may read these records (plan 03, section 5.3).
    const user = withPermissions(requester, 'bookings:view');
    if (user.allowedBranchIds.length === 0) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'new_customer_booking',
        d,
        d.bookingId === null
          ? null
          : {
              type: 'booking',
              id: d.bookingId,
              number: d.bookingNumber,
              path: `/bookings/${d.bookingId}`,
            },
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<NewCustomerBookingDraftDto> {
    return withReplacedBy(this.prisma, TABLE, await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<NewCustomerBookingDraftDto> {
    const draft = await this.findScoped(user, id);
    const customer = await this.customerOf(draft);
    const now = new Date();
    const request = bookingRequestOf(draft);
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft, request, customer)
        : null;
    const container = request.consolidationId
      ? await this.containers.get().describe(user, request.consolidationId)
      : null;
    return {
      ...baseFields(draft, customer, user, now),
      request,
      evidence: evidenceOf(draft.evidence),
      check,
      container,
      missingFields: (await this.completeness(draft)).missing,
    };
  }

  /**
   * A person approves the version they reviewed: the DRAFT booking is created for the new
   * customer in the same transaction as the approval. The customer draft is approved first on its
   * own screen (two steps), or, when `withCustomer` names the customer draft's version the person
   * reviewed and their ticks of its words, here in the same transaction (one step): that needs
   * permission to add customers as well (403 otherwise, nothing approved), and both drafts must
   * still be at the versions reviewed. A customer draft already approved is used as it is.
   * Approving an approved draft returns it as it is, without a second booking.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    confirmed: readonly string[] = [],
    withCustomer: { version: number; confirmed: readonly string[] } | null = null,
  ): Promise<NewCustomerBookingDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is checked or recorded while the customer or the booking misses or holds an invalid
    // value (422).
    requireApprovable(await this.completeness(current));
    // Each value ticked against the staff member's words on the review screen.
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    // An approved customer draft never changes again (a database trigger), so its customer
    // read here is the one the booking gets.
    const customer = await this.customerOf(current);
    const { consolidationId, ...request } = completeBookingRequest(bookingRequestOf(current));
    const plan = await this.approvalPlan(user, current, customer, request, withCustomer);
    await this.requireContainer(user, { ...request, consolidationId });
    const ready =
      plan.kind === 'READY'
        ? await this.bookings.prepareCreate(user, { ...request, customerId: plan.customerId })
        : null;
    await this.prisma.$transaction(async (tx) => {
      let bookingId = '';
      const decided = await decideInTx(tx, {
        table: TABLE,
        id,
        version,
        label: LABEL,
        approving: true,
        gate: async () => {
          const row = await tx.newCustomerBookingDraft.findUniqueOrThrow({
            where: { id },
            include: details,
          });
          requireApprovable(await this.completeness(row, tx));
        },
        record: async () => {
          // One step: the customer draft is locked after this booking draft (the lock order of
          // every path that locks both) and approved first; the booking is for its customer.
          const prepared =
            plan.kind === 'WITH_CUSTOMER'
              ? plan.booking(
                  await this.customerDrafts.approveLinkedInTx(
                    tx,
                    user,
                    current.customerDraftId,
                    plan.customerVersion,
                    plan.customer,
                  ),
                )
              : storedValue(ready, 'booking for the approved customer');
          bookingId = consolidationId
            ? await this.containers.get().bookInTx(tx, user, consolidationId, prepared)
            : await this.bookings.insertInTx(tx, user, prepared);
        },
      });
      if (decided) {
        await tx.newCustomerBookingDraft.update({
          where: { id },
          data: { ...approvedFields(user), bookingId },
        });
      }
    });
    return this.get(user, id);
  }

  /**
   * What an approval records, checked before any lock: the booking for the customer already
   * approved (READY), or, in one step, the customer draft's approval and then the booking for the
   * customer it creates (WITH_CUSTOMER). Refused while the customer draft is open and the person
   * did not review it here (409, the two-step path), lacks permission to add customers (403), or
   * the customer draft was rejected or expired (409).
   */
  private async approvalPlan(
    user: AuthUser,
    current: DraftRow,
    customer: NewCustomerBookingDraftCustomer,
    request: Omit<NewCustomerBookingRequest, 'consolidationId'>,
    withCustomer: { version: number; confirmed: readonly string[] } | null,
  ): Promise<ApprovalPlan> {
    if (customer.status === 'APPROVED' && customer.customerId !== null) {
      return { kind: 'READY', customerId: customer.customerId };
    }
    if (customer.status !== 'DRAFT' || withCustomer === null) {
      throw new ConflictException(customerNotReady(customer) ?? 'Approve the new customer first');
    }
    if (!user.access.has('customers:create', current.branchId)) {
      throw new ForbiddenException(CUSTOMER_PERMISSION_REFUSAL);
    }
    const customerRequest = await this.customerDrafts.prepareLinkedApproval(
      user,
      current.customerDraftId,
      withCustomer.version,
      withCustomer.confirmed,
    );
    return {
      kind: 'WITH_CUSTOMER',
      customer: customerRequest,
      customerVersion: withCustomer.version,
      booking: await this.bookings.prepareForNewCustomer(request, current.branchId),
    };
  }

  async reject(
    user: AuthUser,
    id: string,
    input: { version: number; reason: string },
  ): Promise<NewCustomerBookingDraftDto> {
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
      await tx.newCustomerBookingDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason),
      });
    });
    return this.get(user, id);
  }

  /**
   * NOLON's checks of the booking now: with its customer once that is approved (the customer in
   * the user's branches and active included), else those that need no customer. That the
   * customer is not approved yet is shown from `customer`, not as a refusal. While the booking
   * misses values, those present (null when they pass: `missingFields` says what is missing).
   */
  private async check(
    user: AuthUser,
    draft: DraftRow,
    request: NewCustomerBookingDraftBooking,
    customer: NewCustomerBookingDraftCustomer,
  ): Promise<EntryDraftCheck | null> {
    if (!bookingComplete(request)) {
      const present = await checkDraft(async () => {
        await this.validate(user, draft.branchId, null, request);
        return { total: null, currency: null };
      });
      return present.ok ? null : present;
    }
    return checkDraft(async () => {
      assertBranchAccess(user, draft.branchId);
      const { consolidationId, ...booking } = completeBookingRequest(request);
      await this.requireContainer(user, { ...booking, consolidationId });
      if (customer.customerId !== null) {
        await this.bookings.prepareCreate(user, { ...booking, customerId: customer.customerId });
      } else {
        await this.bookings.prepareWithoutCustomer(booking);
      }
      return { total: null, currency: null };
    });
  }

  /** When the booking names a container: it fits it, and the user may book into it now. */
  private async requireContainer(
    user: AuthUser,
    booking: NewCustomerBookingRequest,
  ): Promise<void> {
    if (booking.consolidationId) {
      await this.containers.get().requireBookable(user, booking.consolidationId, booking);
    }
  }

  /**
   * The approval gate (draft-completeness.ts) on both parts: the customer draft's details
   * (`customer.name`...) and the booking's values.
   */
  private async completeness(
    draft: DraftRow,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Completeness> {
    return pairCompleteness(
      await this.customerDrafts.gateValuesOf(draft.customerDraftId, client),
      bookingRequestOf(draft),
    );
  }

  private async customerOf(draft: DraftRow): Promise<NewCustomerBookingDraftCustomer> {
    return linkedCustomer(await this.customerDrafts.linkedOf([draft.customerDraftId]), draft);
  }

  private async summary(d: DraftRow): Promise<NewCustomerBookingDraftSummaryDto> {
    return {
      id: d.id,
      status: draftStatus(d.state, d.expiresAt, new Date()),
      version: d.version,
      lineCount: bookingRequestOf(d).items.length,
      expiresAt: d.expiresAt.toISOString(),
      createdAt: d.createdAt.toISOString(),
      customerDraftId: d.customerDraftId,
      missingFields: (await this.completeness(d)).missing,
    };
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.newCustomerBookingDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('New customer booking draft not found');
    return draft;
  }
}

/**
 * Locks the pair a new one replaces: the booking draft first (the caller's, through the same
 * client, in a branch they hold, else not found), then its customer draft, under the same rules.
 * No other path locks a customer draft and then its booking draft (an approval of either locks
 * only its own row), so the two locks cannot wait on each other. The link never changes, so it
 * is read without a lock of its own.
 */
async function lockReplacedPairInTx(
  tx: Prisma.TransactionClient,
  id: string | null,
  agentClientId: string,
  user: AuthUser,
): Promise<{ booking: LockedReplacement; customer: LockedReplacement } | null> {
  const booking = await lockReplacedInTx(tx, id, {
    table: TABLE,
    agentClientId,
    user,
    label: LABEL,
  });
  if (booking === null) return null;
  const { customerDraftId } = await tx.newCustomerBookingDraft.findUniqueOrThrow({
    where: { id: booking.id },
    select: { customerDraftId: true },
  });
  const customer = await lockReplacedInTx(tx, customerDraftId, {
    table: 'customer_drafts',
    agentClientId,
    user,
    label: CUSTOMER_LABEL,
  });
  if (customer === null) {
    throw new Error(`New customer booking draft ${booking.id} has no customer draft`);
  }
  return { booking, customer };
}

function gateOf(gates: Map<string, CustomerGate>, d: DraftRow): CustomerGate {
  const gate = gates.get(d.customerDraftId);
  // A foreign key holds the customer draft while this draft exists.
  if (!gate) throw new Error(`New customer booking draft ${d.id} has no customer draft`);
  return gate;
}

function linkedCustomer(
  customers: Map<string, NewCustomerBookingDraftCustomer>,
  d: DraftRow,
): NewCustomerBookingDraftCustomer {
  const customer = customers.get(d.customerDraftId);
  // A foreign key holds the customer draft while this draft exists.
  if (!customer) throw new Error(`New customer booking draft ${d.id} has no customer draft`);
  return customer;
}

function baseFields(
  d: DraftRow,
  customer: NewCustomerBookingDraftCustomer,
  user: AuthUser,
  now: Date,
): Omit<
  NewCustomerBookingDraftDto,
  'request' | 'check' | 'evidence' | 'container' | 'missingFields'
> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.access.has('bookings:create', d.branchId);
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: customer.name ?? '',
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
    customer,
    bookingId: d.bookingId,
    bookingNumber: d.booking?.number ?? null,
  };
}
