import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BOOKING_SERVICES,
  CARGO_TYPES,
  type CustomerDraftRequest,
  type DraftEvidence,
  type DraftPreCheckDto,
  type DraftStatus,
  type EntryDraftCheck,
  LOAD_TYPES,
  NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS,
  type NewCustomerBookingDraftCreateRequest,
  type NewCustomerBookingDraftCustomer,
  type NewCustomerBookingDraftDto,
  type NewCustomerBookingDraftListItemDto,
  type NewCustomerBookingDraftSummaryDto,
  type NewCustomerBookingRequest,
  SHIPPING_MODES,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { dec } from '../common/money.js';
import {
  CustomerDraftsService,
  customerRequestHash,
} from '../customers/customer-drafts.service.js';
import { evidenceHashPart, evidenceOf, requireConfirmed } from '../drafts/draft-evidence.js';
import {
  approvedFields,
  checkDraft,
  draftExpiry,
  type DraftState,
  draftStatus,
  preCheck,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  decideInTx,
  DraftsService,
  keyReused,
  type LockedReplacement,
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
  MY_DRAFTS_ORDER,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BookingsService } from './bookings.service.js';
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
 * The booking as the draft stores it (a JSON object): absent optional fields null, services
 * without repeats, measurements as canonical decimal strings, never numbers.
 */
export function storedRequest(input: NewCustomerBookingRequest): NewCustomerBookingRequest {
  return {
    originLocationId: input.originLocationId.toLowerCase(),
    destinationLocationId: input.destinationLocationId.toLowerCase(),
    mode: input.mode,
    loadType: input.loadType ?? null,
    cargoType: input.cargoType,
    cargoDescription: input.cargoDescription ?? null,
    services: [...new Set(input.services)],
    requestedDeparture: input.requestedDeparture ?? null,
    specialInstructions: input.specialInstructions ?? null,
    // Only when it names one: a booking without a container is stored and hashed as before.
    ...(input.consolidationId ? { consolidationId: input.consolidationId.toLowerCase() } : {}),
    items: input.items.map((item) => ({
      cargoType: item.cargoType,
      containerTypeCode: item.containerTypeCode ?? null,
      description: item.description ?? null,
      quantity: item.quantity,
      weightKg: canonical(item.weightKg),
      volumeCbm: canonical(item.volumeCbm),
    })),
  };
}

const storedShape = z.object({
  originLocationId: z.string(),
  destinationLocationId: z.string(),
  mode: z.enum(SHIPPING_MODES),
  loadType: z.enum(LOAD_TYPES).nullable(),
  cargoType: z.enum(CARGO_TYPES),
  cargoDescription: z.string().nullable(),
  services: z.array(z.enum(BOOKING_SERVICES)),
  requestedDeparture: z.string().nullable(),
  specialInstructions: z.string().nullable(),
  consolidationId: z.string().optional(),
  items: z.array(
    z.object({
      cargoType: z.enum(CARGO_TYPES),
      containerTypeCode: z.string().nullable(),
      description: z.string().nullable(),
      quantity: z.number().int(),
      weightKg: z.string().nullable(),
      volumeCbm: z.string().nullable(),
    }),
  ),
});

/** The booking a stored draft proposes. */
export function bookingRequestOf(d: {
  id: string;
  request: Prisma.JsonValue;
}): NewCustomerBookingRequest {
  const parsed = storedShape.safeParse(d.request);
  if (!parsed.success) throw new Error(`New customer booking draft ${d.id} has no valid booking`);
  return parsed.data;
}

/**
 * sha256 of the whole request: the branch and the customer with its words (as a customer draft
 * hashes them), the booking normalised as stored (services sorted), and the booking's words.
 */
export function newCustomerBookingHash(
  branchId: string,
  customer: CustomerDraftRequest,
  booking: NewCustomerBookingRequest,
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
    const { branchId, customer, booking, evidence = [] } = valuesOf(body);
    return preCheck(newCustomerBookingHash(branchId, customer, booking, evidence), async () => {
      await this.customerDrafts.prepareNew(user, branchId, customer);
      // As the create would: a phone already taken in the branch refuses the pair.
      await this.customerDrafts.requirePhoneFree(branchId, customer.phone, 'customer.phone');
      await this.bookings.prepareWithoutCustomer(booking);
      await this.requireContainer(user, booking);
    });
  }

  async create(
    user: AuthUser,
    body: NewCustomerBookingDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<NewCustomerBookingDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    // The route asks for bookings:create; the customer part is a customer draft, which needs
    // customers:create of its own.
    if (!user.permissions.has('customers:create')) {
      throw new ForbiddenException('Proposing a new customer needs permission to add customers');
    }
    const { idempotencyKey, branchId, customer, booking, evidence = [] } = body;
    const hash = withReplaced(
      newCustomerBookingHash(branchId, customer, booking, evidence),
      replacesDraftId,
    );
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, TABLE, scope, hash);
    if (stored !== null) return this.summary(await this.findScoped(user, stored));
    // The checks of a real create that need no lock, for both parts; nothing is written.
    await this.customerDrafts.prepareNew(user, branchId, customer);
    await this.bookings.prepareWithoutCustomer(booking);
    await this.requireContainer(user, booking);
    const words = splitEvidence(evidence);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedPairInTx(tx, replacesDraftId, agentClientId, user);
        const existing = await tx.newCustomerBookingDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
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
  ): Promise<NewCustomerBookingDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.newCustomerBookingDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...(mine ? mineWhere(user, mine) : {}),
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: mine?.limit ?? 200,
    });
    const customers = await this.customerDrafts.linkedOf(drafts.map((d) => d.customerDraftId));
    return drafts.map((d) => ({
      ...baseFields(d, linkedCustomer(customers, d), user, now),
      lineCount: bookingRequestOf(d).items.length,
    }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('bookings:view')) return [];
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
      ? await this.containers.get().describe(request.consolidationId)
      : null;
    return {
      ...baseFields(draft, customer, user, now),
      request,
      evidence: evidenceOf(draft.evidence),
      check,
      container,
    };
  }

  /**
   * A person approves the version they reviewed, once the new customer is approved: the DRAFT
   * booking is created for that customer in the same transaction as the approval. Approving an
   * approved draft returns it as it is, without a second booking.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    confirmed: readonly string[] = [],
  ): Promise<NewCustomerBookingDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Each value ticked against the staff member's words on the review screen.
    requireConfirmed(evidenceOf(current.evidence), confirmed);
    // An approved customer draft never changes again (a database trigger), so its customer
    // read here is the one the booking gets.
    const customer = await this.customerOf(current);
    const notReady = customerNotReady(customer);
    if (notReady !== null || customer.customerId === null) {
      throw new ConflictException(notReady ?? 'Approve the new customer first');
    }
    const { consolidationId, ...request } = bookingRequestOf(current);
    await this.requireContainer(user, { ...request, consolidationId });
    const prepared = await this.bookings.prepareCreate(user, {
      ...request,
      customerId: customer.customerId,
    });
    await this.prisma.$transaction(async (tx) => {
      let bookingId = '';
      const decided = await decideInTx(tx, {
        table: TABLE,
        id,
        version,
        label: LABEL,
        approving: true,
        record: async () => {
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
   * customer is not approved yet is shown from `customer`, not as a refusal.
   */
  private check(
    user: AuthUser,
    draft: DraftRow,
    request: NewCustomerBookingRequest,
    customer: NewCustomerBookingDraftCustomer,
  ): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      assertBranchAccess(user, draft.branchId);
      const { consolidationId, ...booking } = request;
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

  private async customerOf(draft: DraftRow): Promise<NewCustomerBookingDraftCustomer> {
    return linkedCustomer(await this.customerDrafts.linkedOf([draft.customerDraftId]), draft);
  }

  private summary(d: DraftRow): NewCustomerBookingDraftSummaryDto {
    return {
      id: d.id,
      status: draftStatus(d.state, d.expiresAt, new Date()),
      version: d.version,
      lineCount: bookingRequestOf(d).items.length,
      expiresAt: d.expiresAt.toISOString(),
      createdAt: d.createdAt.toISOString(),
      customerDraftId: d.customerDraftId,
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
): Omit<NewCustomerBookingDraftDto, 'request' | 'check' | 'evidence' | 'container'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('bookings:create');
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: customer.name,
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
    customer,
    bookingId: d.bookingId,
    bookingNumber: d.booking?.number ?? null,
  };
}
