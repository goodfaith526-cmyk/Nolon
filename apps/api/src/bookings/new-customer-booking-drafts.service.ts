import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BOOKING_SERVICES,
  CARGO_TYPES,
  LOAD_TYPES,
  NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS,
  SHIPPING_MODES,
  type CustomerDraftRequest,
  type DraftEvidence,
  type DraftStatus,
  type EntryDraftCheck,
  type NewCustomerBookingDraftCreateRequest,
  type NewCustomerBookingDraftCustomer,
  type NewCustomerBookingDraftDto,
  type NewCustomerBookingDraftListItemDto,
  type NewCustomerBookingDraftSummaryDto,
  type NewCustomerBookingRequest,
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
  draftStatus,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  DraftsService,
  decideInTx,
  keyReused,
  storedDraftUnderKey,
  withReplacedBy,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BookingsService } from './bookings.service.js';

const LABEL = 'new customer booking draft';
const ASSISTANT_ONLY = 'Bookings for a new customer are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a booking for a new customer';
const TABLE = 'new_customer_booking_drafts';

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
 */
@Injectable()
export class NewCustomerBookingDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly customerDrafts: CustomerDraftsService,
    private readonly drafts: DraftsService,
  ) {}

  async create(
    user: AuthUser,
    body: NewCustomerBookingDraftCreateRequest,
  ): Promise<NewCustomerBookingDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    // The route asks for bookings:create; the customer part is a customer draft, which needs
    // customers:create of its own.
    if (!user.permissions.has('customers:create')) {
      throw new ForbiddenException('Proposing a new customer needs permission to add customers');
    }
    const { idempotencyKey, branchId, customer, booking, evidence = [] } = body;
    const hash = newCustomerBookingHash(branchId, customer, booking, evidence);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, TABLE, scope, hash);
    if (stored !== null) return this.summary(await this.findScoped(user, stored));
    // The checks of a real create that need no lock, for both parts; nothing is written.
    await this.customerDrafts.prepareNew(user, branchId, customer);
    await this.bookings.prepareWithoutCustomer(booking);
    const words = splitEvidence(evidence);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.newCustomerBookingDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // The customer draft under the same key in its own table (a phone taken is a 409 there).
        const customerDraftId = await this.customerDrafts.createInTx(tx, user, {
          agentClientId,
          idempotencyKey,
          branchId,
          input: customer,
          evidence: words.customer,
        });
        const draft = await tx.newCustomerBookingDraft.create({
          data: {
            ...scope,
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

  async list(user: AuthUser, status?: DraftStatus): Promise<NewCustomerBookingDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.newCustomerBookingDraft.findMany({
      where: { ...branchScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const customers = await this.customerDrafts.linkedOf(drafts.map((d) => d.customerDraftId));
    return drafts.map((d) => ({
      ...baseFields(d, linkedCustomer(customers, d), user, now),
      lineCount: bookingRequestOf(d).items.length,
    }));
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
    return {
      ...baseFields(draft, customer, user, now),
      request,
      evidence: evidenceOf(draft.evidence),
      check,
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
    const prepared = await this.bookings.prepareCreate(user, {
      ...bookingRequestOf(current),
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
          bookingId = await this.bookings.insertInTx(tx, user, prepared);
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
      if (customer.customerId !== null) {
        await this.bookings.prepareCreate(user, { ...request, customerId: customer.customerId });
      } else {
        await this.bookings.prepareWithoutCustomer(request);
      }
      return { total: null, currency: null };
    });
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
): Omit<NewCustomerBookingDraftDto, 'request' | 'check' | 'evidence'> {
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
