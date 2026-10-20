import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssistantDraftApproveRequest,
  AssistantDraftDto,
  BookingDraftCreateRequest,
  BookingDraftDirect,
  BookingDraftFromQuotation,
  BookingDraftItem,
  BookingDraftUpdateRequest,
  BookingDraftDto,
  BookingDraftListItemDto,
  BookingDraftRequest,
  BookingFromQuotationRequest,
  BookingItemInput,
  BookingService,
  ContainerChoice,
  CreateBookingRequest,
  DraftPreCheckDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { fromDbDate, toDbDate } from '../common/dates.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import {
  checkDraft,
  decimalKey,
  draftBranch,
  draftExpiry,
  draftStatus,
  patched,
  preCheck,
  storedValue,
  requestHash,
  requireOpen,
  stateFilter,
  withBranch,
} from '../drafts/draft-rules.js';
import {
  decidedVia,
  type DecisionVia,
  DraftsService,
  keyReused,
  lockDraftRow,
  lockReplacedInTx,
  mineWhere,
  myDraftItem,
  type MyDraftRow,
  type MyDraftsQuery,
  replaceInTx,
  storedDraftUnderKey,
  valuesOf,
  type ValuesOf,
  withReplaced,
  withReplacedBy,
  MY_DRAFTS_ORDER,
  lockKeyInTx,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BookingsService, type PreparedBooking } from './bookings.service.js';
import { ContainerBookingsRegistry } from './container-bookings.registry.js';
import { bookingCompleteness, requireApprovable } from '../drafts/draft-completeness.js';

const LABEL = 'booking draft';
const ASSISTANT_ONLY = 'Booking drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a booking draft';

const details = {
  items: { orderBy: { lineNo: 'asc' } },
  customer: { select: { name: true } },
  sourceQuotation: { select: { number: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  booking: { select: { number: true } },
} satisfies Prisma.BookingDraftInclude;

type DraftRow = Prisma.BookingDraftGetPayload<{ include: typeof details }>;

type DirectRequest = CreateBookingRequest & ContainerChoice;
type FromQuotationRequest = BookingFromQuotationRequest & { quotationId: string };
/** A draft's values: a direct booking's, or one made from a quotation, as stored. */
type QuotedValues = BookingDraftFromQuotation & { quotationId: string };
type DraftInput = BookingDraftDirect | QuotedValues;

/**
 * A create body's values, and the branch it names (security context, not a value): a direct
 * draft's customer's, or the quotation's, which a branch given must be; with neither, the branch.
 */
function splitBranch(input: ValuesOf<BookingDraftCreateRequest>): {
  values: DraftInput;
  branchId: string | null;
} {
  const { branchId, ...values } = input;
  return { values, branchId: branchId ?? null };
}

function isFromQuotation<Q extends { quotationId: string }, D>(input: Q | D): input is Q {
  return (
    typeof input === 'object' &&
    input !== null &&
    'quotationId' in input &&
    typeof input.quotationId === 'string'
  );
}

/**
 * What a booking draft still misses before it can be approved: the approval gate's missing values
 * (draft-completeness.ts), from a booking's own rules.
 */
export function bookingMissingFields(input: DraftInput): string[] {
  return bookingCompleteness(input).missing;
}

function completeItems(items: readonly BookingDraftItem[] | undefined): BookingItemInput[] {
  return (items ?? []).map((item) => ({
    ...item,
    cargoType: storedValue(item.cargoType, 'item cargo type'),
    quantity: storedValue(item.quantity, 'item quantity'),
  }));
}

/** The booking of a complete draft, in the shape BookingsService takes. */
function completeBooking(input: DraftInput): DirectRequest | FromQuotationRequest {
  if (isFromQuotation(input)) {
    const { items, ...rest } = input;
    return items === undefined ? rest : { ...rest, items: completeItems(items) };
  }
  return {
    ...input,
    customerId: storedValue(input.customerId, 'customer'),
    originLocationId: storedValue(input.originLocationId, 'origin'),
    destinationLocationId: storedValue(input.destinationLocationId, 'destination'),
    mode: storedValue(input.mode, 'mode'),
    cargoType: input.cargoType ?? null,
    services: input.services ?? [],
    items: completeItems(input.items),
  };
}

function storedItems(items: readonly BookingDraftItem[] | undefined) {
  const decimal = (v: string | null | undefined) => (v === null || v === undefined ? null : dec(v));
  return (items ?? []).map((item, i) => ({
    lineNo: i + 1,
    cargoType: item.cargoType ?? null,
    containerTypeCode: item.containerTypeCode ?? null,
    description: item.description ?? null,
    quantity: item.quantity ?? null,
    lengthCm: decimal(item.lengthCm),
    widthCm: decimal(item.widthCm),
    heightCm: decimal(item.heightCm),
    weightKg: decimal(item.weightKg),
    volumeCbm: decimal(item.volumeCbm),
  }));
}

type StoredItem = ReturnType<typeof storedItems>[number];

function itemInput(item: StoredItem): BookingDraftItem {
  return {
    cargoType: item.cargoType,
    containerTypeCode: item.containerTypeCode,
    description: item.description,
    quantity: item.quantity,
    lengthCm: toDecimalStringOrNull(item.lengthCm),
    widthCm: toDecimalStringOrNull(item.widthCm),
    heightCm: toDecimalStringOrNull(item.heightCm),
    weightKg: toDecimalStringOrNull(item.weightKg),
    volumeCbm: toDecimalStringOrNull(item.volumeCbm),
  };
}

/** The request a stored draft proposes, as stored (a value the draft misses is null). */
export function requestOf(d: DraftRow): BookingDraftRequest {
  const parties = {
    shipperId: d.shipperId,
    consigneeId: d.consigneeId,
    notifyPartyId: d.notifyPartyId,
    requestedDeparture: d.requestedDeparture ? fromDbDate(d.requestedDeparture) : null,
    specialInstructions: d.specialInstructions,
    items: d.items.map(itemInput),
  };
  if (d.sourceQuotationId) {
    return {
      quotationId: d.sourceQuotationId,
      quotationNumber: d.sourceQuotation?.number ?? '',
      services: d.services,
      ...parties,
    };
  }
  return {
    customerId: d.customerId,
    ...(d.consolidationId ? { consolidationId: d.consolidationId } : {}),
    originLocationId: d.originLocationId,
    destinationLocationId: d.destinationLocationId,
    mode: d.mode,
    loadType: d.loadType,
    cargoType: d.cargoType,
    cargoDescription: d.cargoDescription,
    services: d.services,
    ...parties,
  };
}

/**
 * sha256 of the normalised request: decimals canonical, missing and null alike, keys sorted (a
 * complete request hashes as it always has).
 */
export function bookingRequestHash(input: DraftInput): string {
  const lower = (v: string | null | undefined) => v?.toLowerCase() ?? null;
  const common = {
    services: input.services ? [...new Set(input.services)].sort() : null,
    shipperId: lower(input.shipperId),
    consigneeId: lower(input.consigneeId),
    notifyPartyId: lower(input.notifyPartyId),
    requestedDeparture: input.requestedDeparture ?? null,
    specialInstructions: input.specialInstructions ?? null,
    items: storedItems(input.items).map((i) => ({
      ...i,
      containerTypeCode: i.containerTypeCode,
      lengthCm: decimalKey(i.lengthCm),
      widthCm: decimalKey(i.widthCm),
      heightCm: decimalKey(i.heightCm),
      weightKg: decimalKey(i.weightKg),
      volumeCbm: decimalKey(i.volumeCbm),
    })),
  };
  if (isFromQuotation(input)) {
    return requestHash({
      kind: 'QUOTATION',
      quotationId: input.quotationId.toLowerCase(),
      ...common,
    });
  }
  return requestHash({
    kind: 'DIRECT',
    // Only when it names one: a draft without a container hashes as it did before.
    ...(input.consolidationId ? { consolidationId: input.consolidationId.toLowerCase() } : {}),
    customerId: lower(input.customerId),
    originLocationId: lower(input.originLocationId),
    destinationLocationId: lower(input.destinationLocationId),
    mode: input.mode ?? null,
    loadType: input.loadType ?? null,
    cargoType: input.cargoType ?? null,
    cargoDescription: input.cargoDescription ?? null,
    ...common,
  });
}

/** What a draft is filed under and the services it stores, once its values are checked. */
interface CheckedBooking {
  branchId: string;
  customerId: string | null;
  quotationId: string | null;
  services: BookingService[];
}

/**
 * Booking drafts proposed by the staff AI assistant (entry drafts, src/drafts): from an approved
 * quotation or directly for a customer. A person approves (an ordinary DRAFT booking is created
 * through BookingsService in the same transaction, with that person's permissions and branches:
 * not confirmed, no shipment) or rejects. Access follows the customer's branch.
 *
 * A direct draft may name an open LCL container (`consolidationId`): approving it then books into
 * the container as its page does (ContainerBookingsRegistry): the booking is recorded, confirmed
 * and its shipment put in the container, in the approval's transaction, under the container's
 * rules for the person approving (any branch may book into an open container).
 */
@Injectable()
export class BookingDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly drafts: DraftsService,
    private readonly containers: ContainerBookingsRegistry,
  ) {}

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: BookingDraftCreateRequest): Promise<DraftPreCheckDto> {
    const { values: input, branchId } = splitBranch(valuesOf(body));
    return preCheck(withBranch(bookingRequestHash(input), branchId), async () => {
      await this.validate(user, input, branchId);
      return { total: null, currency: null, missingFields: bookingMissingFields(input) };
    });
  }

  /**
   * The checks a draft's values get on create and on a person's edit: a complete booking's in
   * full (prepare, its container included); one still missing values, those of the values present.
   * A direct draft's branch is its customer's, which a branch given must be; with no customer
   * yet, the branch given, one of the user's. One made from a quotation is the quotation's (its
   * customer's), which a branch given must be too.
   */
  private async validate(
    user: AuthUser,
    input: DraftInput,
    branchId: string | null,
  ): Promise<CheckedBooking> {
    if (bookingMissingFields(input).length === 0) {
      const prepared = await this.prepare(user, completeBooking(input));
      return {
        branchId: draftBranch(user, branchId, prepared.branchId),
        customerId: prepared.customerId,
        quotationId: prepared.quotationId,
        services: prepared.header.services,
      };
    }
    if (isFromQuotation(input)) {
      const checked = await this.bookings.checkPresentFromQuotation(user, input.quotationId, input);
      return {
        ...checked,
        branchId: draftBranch(user, branchId, checked.branchId),
        services: [...new Set<BookingService>(input.services ?? ['MAIN_FREIGHT'])],
      };
    }
    const checked = await this.bookings.checkPresent(user, input, branchId);
    // A container named is a reference checked now, whatever else is missing (Codex on 98f9727):
    // whether the booking fits it waits for its route and cargo (prepare, requireBookable).
    if (input.consolidationId) {
      await this.containers.get().requireReference(user, input.consolidationId);
    }
    return { ...checked, quotationId: null, services: [...new Set(input.services ?? [])] };
  }

  async create(
    user: AuthUser,
    body: BookingDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const { idempotencyKey, ...rest } = body;
    const { values: input, branchId } = splitBranch(rest);
    const hash = withReplaced(withBranch(bookingRequestHash(input), branchId), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'booking_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // What NOLON would check on a real create, on the values present; nothing is written.
    const prepared = await this.validate(user, input, branchId);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'booking_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'booking_drafts', scope);
        const existing = await tx.bookingDraft.findUnique({
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
        const draft = await tx.bookingDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            sourceQuotationId: prepared.quotationId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            ...columnsOf(input, prepared.services),
            branchId: prepared.branchId,
            customerId: prepared.customerId,
          },
          select: { id: true },
        });
        const items = storedItems(input.items);
        if (items.length > 0) {
          await tx.bookingDraftItem.createMany({
            data: items.map((item) => ({ ...item, draftId: draft.id })),
          });
        }
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /**
   * A person fills in or changes values of an open draft, at the version they read: the values
   * are checked as on create, and the version moves on. A draft made from a quotation takes no
   * route, cargo or container (they come from the quotation). The assistant's request (its
   * payload hash) stays the draft's, so a replay of that create still finds this draft.
   */
  async update(
    user: AuthUser,
    id: string,
    input: BookingDraftUpdateRequest,
  ): Promise<BookingDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    const stored = serviceRequest(requestOf(current));
    let values: DraftInput;
    if (isFromQuotation(stored)) {
      const { services, shipperId, consigneeId, notifyPartyId, items, ...rest } = patch;
      const { requestedDeparture, specialInstructions, ...others } = rest;
      if (Object.values(others).some((v) => v !== undefined)) {
        throw new BadRequestException(
          'A booking made from a quotation takes its route and cargo from the quotation',
        );
      }
      values = patched(stored, {
        services,
        shipperId,
        consigneeId,
        notifyPartyId,
        requestedDeparture,
        specialInstructions,
        items,
      });
    } else {
      values = patched(stored, patch);
    }
    // A customer named here must be of the draft's branch: a draft never changes branch.
    const checked = await this.validate(user, values, current.branchId);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'booking_drafts', id);
      if (!locked) throw new NotFoundException('Booking draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.bookingDraft.update({
        where: { id },
        data: {
          ...columnsOf(values, checked.services),
          customerId: checked.customerId,
          version: { increment: 1 },
        },
      });
      if (patch.items !== undefined) {
        await tx.bookingDraftItem.deleteMany({ where: { draftId: id } });
        const items = storedItems(values.items);
        if (items.length > 0) {
          await tx.bookingDraftItem.createMany({
            data: items.map((item) => ({ ...item, draftId: id })),
          });
        }
      }
    });
    return this.get(user, id);
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.bookingDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Booking draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
  ): Promise<BookingDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.bookingDraft.findMany({
      where: {
        ...branchScope(user),
        ...stateFilter(status, now),
        ...(mine ? mineWhere(user, mine) : {}),
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: mine?.limit ?? 200,
    });
    return drafts.map((d) => reviewFields(d, user, now));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('bookings:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'booking',
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

  async get(user: AuthUser, id: string): Promise<BookingDraftDto> {
    return withReplacedBy(this.prisma, 'booking_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<BookingDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    const check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    const container = draft.consolidationId
      ? await this.containers.get().describe(user, draft.consolidationId)
      : null;
    return { ...toDto(draft, user, now, check), container };
  }

  /**
   * A person approves the version they reviewed: the booking is created through BookingsService
   * with their permissions and branches, in the same transaction as the approval. Approving an
   * approved draft returns it as it is, without a second booking.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    via: DecisionVia = 'SESSION',
  ): Promise<BookingDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is recorded while the draft misses a value (422, naming each one).
    const values = serviceRequest(requestOf(current));
    requireApprovable(bookingCompleteness(values));
    const prepared = await this.prepare(user, completeBooking(values));
    const containerId = current.consolidationId;
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'booking_drafts', id);
      if (!locked) throw new NotFoundException('Booking draft not found');
      if (locked.state === 'APPROVED') return;
      requireOpen(locked, version, LABEL);
      // The gate again, on the row as locked: what is recorded is complete and valid.
      const row = await tx.bookingDraft.findUniqueOrThrow({ where: { id }, include: details });
      requireApprovable(bookingCompleteness(serviceRequest(requestOf(row))));
      const bookingId = containerId
        ? await this.containers.get().bookInTx(tx, user, containerId, prepared)
        : await this.bookings.insertInTx(tx, user, prepared);
      await tx.bookingDraft.update({
        where: { id },
        data: {
          state: 'APPROVED',
          bookingId,
          decidedById: user.id,
          decidedAt: new Date(),
          decidedVia: decidedVia(via),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  /** The draft as the assistant's chat card shows it (erp-agents docs/chat-draft-approval.md). */
  async forAssistant(user: AuthUser, id: string): Promise<AssistantDraftDto<BookingDraftDto>> {
    const draft = await this.get(user, id);
    return this.drafts.assistantView(user, 'booking', 'booking_drafts', draft, LABEL);
  }

  /** A person approves in the assistant's chat the content the card showed them. */
  async approveFromAssistant(
    user: AuthUser,
    id: string,
    input: AssistantDraftApproveRequest,
  ): Promise<BookingDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'booking',
      'booking_drafts',
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
  ): Promise<BookingDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'booking',
      'booking_drafts',
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
  ): Promise<BookingDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'booking_drafts', id);
      if (!locked) throw new NotFoundException('Booking draft not found');
      requireOpen(locked, input.version, LABEL);
      await tx.bookingDraft.update({
        where: { id },
        data: {
          state: 'REJECTED',
          rejectReason: input.reason,
          decidedById: user.id,
          decidedAt: new Date(),
          decidedVia: decidedVia(via),
          version: { increment: 1 },
        },
      });
    });
    return this.get(user, id);
  }

  /**
   * What NOLON checks on a real create, for this user now; for a draft that names a container,
   * also that the booking fits it and that the user may book into it. Nothing is written.
   */
  private async prepare(
    user: AuthUser,
    input: DirectRequest | FromQuotationRequest,
  ): Promise<PreparedBooking> {
    if (isFromQuotation(input)) {
      const { quotationId, ...rest } = input;
      return this.bookings.prepareFromQuotation(user, quotationId, rest);
    }
    const { consolidationId, ...booking } = input;
    if (consolidationId) {
      await this.containers.get().requireBookable(user, consolidationId, booking);
    }
    return this.bookings.prepareCreate(user, booking);
  }

  /**
   * Whether NOLON would accept the draft now; null while it misses values and those present pass
   * (it waits for them: missingFields).
   */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const values = serviceRequest(requestOf(draft));
    const complete = bookingMissingFields(values).length === 0;
    const result = await checkDraft(async () => {
      if (complete) await this.prepare(user, completeBooking(values));
      else await this.validate(user, values, draft.branchId);
      return { total: null, currency: null };
    });
    return complete || !result.ok ? result : null;
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.bookingDraft.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Booking draft not found');
    return draft;
  }
}

/** The value columns of a draft (its items apart), a missing value as NULL. */
function columnsOf(input: DraftInput, services: BookingService[]) {
  const quoted = isFromQuotation(input);
  return {
    // A draft made from a quotation stores no route or cargo (booking_drafts_source_check).
    originLocationId: quoted ? null : (input.originLocationId ?? null),
    destinationLocationId: quoted ? null : (input.destinationLocationId ?? null),
    mode: quoted ? null : (input.mode ?? null),
    loadType: quoted ? null : (input.loadType ?? null),
    cargoType: quoted ? null : (input.cargoType ?? null),
    cargoDescription: quoted ? null : (input.cargoDescription ?? null),
    consolidationId: quoted ? null : (input.consolidationId ?? null),
    services,
    shipperId: input.shipperId ?? null,
    consigneeId: input.consigneeId ?? null,
    notifyPartyId: input.notifyPartyId ?? null,
    requestedDeparture: input.requestedDeparture ? toDbDate(input.requestedDeparture) : null,
    specialInstructions: input.specialInstructions ?? null,
  };
}

/** The stored request without its display-only fields. */
function serviceRequest(request: BookingDraftRequest): DraftInput {
  if (request.quotationId === undefined) return request;
  return {
    quotationId: request.quotationId,
    services: request.services,
    shipperId: request.shipperId,
    consigneeId: request.consigneeId,
    notifyPartyId: request.notifyPartyId,
    requestedDeparture: request.requestedDeparture,
    specialInstructions: request.specialInstructions,
    items: request.items,
  };
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.items.length,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    missingFields: bookingMissingFields(serviceRequest(requestOf(d))),
  };
}

function toDto(
  d: DraftRow,
  user: AuthUser,
  now: Date,
  check: EntryDraftCheck | null,
): Omit<BookingDraftDto, 'container'> {
  return { ...baseFields(d, user, now), request: requestOf(d), check };
}

function reviewFields(d: DraftRow, user: AuthUser, now: Date): BookingDraftListItemDto {
  return {
    ...baseFields(d, user, now),
    lineCount: d.items.length,
    sourceQuotationNumber: d.sourceQuotation?.number ?? null,
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
): Omit<BookingDraftDto, 'request' | 'check' | 'container'> {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('bookings:create');
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
    missingFields: bookingMissingFields(serviceRequest(requestOf(d))),
    bookingId: d.bookingId,
    bookingNumber: d.booking?.number ?? null,
  };
}
