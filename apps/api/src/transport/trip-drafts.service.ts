import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { type DraftPreCheckDto, seesTransportCosts } from '@nolon/shared';
import type {
  AssistantDraftApproveRequest,
  AssistantDraftDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  TripDraftCreateRequest,
  TripDraftDto,
  TripDraftListItemDto,
  TripDraftUpdateRequest,
  TripDraftValues,
  TripInput,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import {
  approvedFields,
  checkDraft,
  decimalKey,
  draftExpiry,
  draftStatus,
  patched,
  preCheck,
  storedValue,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  decidedVia,
  decideInTx,
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
import { shipmentScope } from '../shipments/shipment-scope.js';
import { forbidDriverOnly } from './trip-scope.js';
import { TripsService } from './trips.service.js';
import { requireApprovable, tripCompleteness } from '../drafts/draft-completeness.js';

const LABEL = 'trip draft';

/**
 * Trip drafts are office planning. A Driver sees only the trips assigned to them (annex A), and a
 * draft has no driver of its own yet, so a Driver-only user gets none of them, read or write; a
 * user whose other roles grant trips sees the branch's drafts as they see its trips.
 */
function draftScope(user: AuthUser): Prisma.TripDraftWhereInput {
  forbidDriverOnly(user, 'see or decide trip drafts');
  return branchScope(user);
}
const ASSISTANT_ONLY = 'Trip drafts are proposed by the assistant';
const HUMAN_ONLY = 'Only a person can decide on a trip draft';

const details = {
  shipments: { orderBy: { lineNo: 'asc' }, select: { shipmentId: true } },
  createdBy: { select: { fullName: true } },
  decidedBy: { select: { fullName: true } },
  trip: { select: { number: true } },
} satisfies Prisma.TripDraftInclude;

type DraftRow = Prisma.TripDraftGetPayload<{ include: typeof details }>;
type TripDraftReviewFields = Omit<
  TripDraftDto,
  'request' | 'check' | 'shipmentNumbers' | 'vehiclePlate' | 'driverName' | 'carrierName'
>;

/** The trip a stored draft proposes, as stored: a missing value is null. */
export function requestOf(d: DraftRow): TripDraftValues {
  return {
    branchId: d.branchId,
    kind: d.kind,
    originLocationId: d.originLocationId,
    destinationLocationId: d.destinationLocationId,
    plannedDeparture: d.plannedDeparture?.toISOString() ?? null,
    plannedArrival: d.plannedArrival?.toISOString() ?? null,
    vehicleId: d.vehicleId,
    driverId: d.driverId,
    carrierId: d.carrierId,
    agreedCost: toDecimalStringOrNull(d.agreedCost),
    currency: d.currency,
    externalVehicle: d.externalVehicle,
    externalDriver: d.externalDriver,
    notes: d.notes,
    shipmentIds: shipmentIdsOf(d),
  };
}

/** The shipments a draft names, in order (a line without its shipment yet names none). */
function shipmentIdsOf(d: DraftRow): string[] {
  return d.shipments.flatMap((s) => (s.shipmentId === null ? [] : [s.shipmentId]));
}

/**
 * What a trip draft still misses before it can be approved: the approval gate's missing values
 * (draft-completeness.ts), from a trip's own rules.
 */
export function tripMissingFields(values: TripDraftValues): string[] {
  return tripCompleteness(values).missing;
}

/** The trip a complete draft proposes, in the shape TripsService takes. */
export function completeTrip(values: TripDraftValues): TripInput {
  return {
    ...values,
    kind: storedValue(values.kind, 'kind'),
    originLocationId: storedValue(values.originLocationId, 'origin'),
    destinationLocationId: storedValue(values.destinationLocationId, 'destination'),
  };
}

/** A trip draft's values from a create body (absent shipments are none yet). */
function valuesOfCreate(input: ValuesOf<TripDraftCreateRequest>): TripDraftValues {
  return { ...input, shipmentIds: input.shipmentIds ?? [] };
}

/**
 * sha256 of the normalised request: ids lower case, times and decimals canonical, keys sorted, a
 * missing value null (a complete request hashes as it always has).
 */
export function tripRequestHash(input: TripDraftValues): string {
  const lower = (v: string | null | undefined) => v?.toLowerCase() ?? null;
  const time = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);
  return requestHash({
    branchId: input.branchId.toLowerCase(),
    kind: input.kind ?? null,
    originLocationId: lower(input.originLocationId),
    destinationLocationId: lower(input.destinationLocationId),
    plannedDeparture: time(input.plannedDeparture),
    plannedArrival: time(input.plannedArrival),
    vehicleId: lower(input.vehicleId),
    driverId: lower(input.driverId),
    carrierId: lower(input.carrierId),
    agreedCost: input.agreedCost ? decimalKey(dec(input.agreedCost)) : null,
    currency: input.currency ?? null,
    externalVehicle: input.externalVehicle ?? null,
    externalDriver: input.externalDriver ?? null,
    notes: input.notes ?? null,
    shipmentIds: input.shipmentIds.map((id) => id.toLowerCase()),
  });
}

/**
 * Trip drafts proposed by the staff AI assistant (entry drafts, src/drafts). A person approves a
 * draft, which plans the trip through TripsService in the same transaction with their
 * permissions and branches (fleet and currency checked under their locks, shipments scheduled),
 * or rejects it. Access follows the trip's branch.
 */
@Injectable()
export class TripDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trips: TripsService,
    private readonly drafts: DraftsService,
  ) {}

  /** The pre-check: what `create` checks for these values, for this user now; nothing is written. */
  checkValues(user: AuthUser, body: TripDraftCreateRequest): Promise<DraftPreCheckDto> {
    draftScope(user);
    const values = valuesOfCreate(valuesOf(body));
    return preCheck(tripRequestHash(values), async () => {
      const missingFields = (await this.validate(user, values)).missingFields;
      return { total: null, currency: null, missingFields };
    });
  }

  /**
   * The checks a draft's values get on create and on a person's edit: a complete trip's in full
   * (prepareCreate); a trip still missing values, those of the values present (checkPresent).
   */
  private async validate(
    user: AuthUser,
    values: TripDraftValues,
  ): Promise<{
    missingFields: string[];
    plannedDeparture: Date | null;
    plannedArrival: Date | null;
  }> {
    const missingFields = tripMissingFields(values);
    if (missingFields.length === 0) {
      const prepared = await this.trips.prepareCreate(user, completeTrip(values));
      return { missingFields, ...prepared };
    }
    await this.trips.checkPresent(user, values);
    const time = (v: string | null | undefined) => (v ? new Date(v) : null);
    return {
      missingFields,
      plannedDeparture: time(values.plannedDeparture),
      plannedArrival: time(values.plannedArrival),
    };
  }

  async create(
    user: AuthUser,
    body: TripDraftCreateRequest,
    replacesDraftId: string | null = null,
  ): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    draftScope(user);
    const { idempotencyKey, ...rest } = body;
    const input = valuesOfCreate(rest);
    const hash = withReplaced(tripRequestHash(input), replacesDraftId);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    // A stored request under this key is answered first, before any check on live data: a replay
    // after the approval, or after the records moved on, finds its draft instead of a refusal.
    const stored = await storedDraftUnderKey(this.prisma, 'trip_drafts', scope, hash);
    if (stored !== null) return toSummary(await this.findScoped(user, stored), new Date());
    // The checks of a real trip that need no lock, on the values present; nothing is written.
    const prepared = await this.validate(user, input);
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        // Locked before the key lookup: an identical retry waits here, then finds the winner.
        const replaced = await lockReplacedInTx(tx, replacesDraftId, {
          table: 'trip_drafts',
          agentClientId,
          user,
          label: LABEL,
        });
        await lockKeyInTx(tx, 'trip_drafts', scope);
        const existing = await tx.tripDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        // The user holds the branch now, as stored (not only as their request loaded it).
        await requireBranchMemberInTx(tx, user, input.branchId);
        if (replaced) await replaceInTx(tx, replaced);
        const draft = await tx.tripDraft.create({
          data: {
            ...scope,
            replacesDraftId,
            branchId: input.branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            kind: input.kind ?? null,
            originLocationId: input.originLocationId,
            destinationLocationId: input.destinationLocationId,
            plannedDeparture: prepared.plannedDeparture,
            plannedArrival: prepared.plannedArrival,
            vehicleId: input.vehicleId ?? null,
            driverId: input.driverId ?? null,
            carrierId: input.carrierId ?? null,
            agreedCost: input.agreedCost ? dec(input.agreedCost) : null,
            currency: input.currency ?? null,
            externalVehicle: input.externalVehicle ?? null,
            externalDriver: input.externalDriver ?? null,
            notes: input.notes ?? null,
          },
          select: { id: true },
        });
        await tx.tripDraftShipment.createMany({
          data: input.shipmentIds.map((shipmentId, i) => ({
            draftId: draft.id,
            lineNo: i + 1,
            shipmentId,
          })),
        });
        return draft.id;
      }),
    );
    return toSummary(await this.findScoped(user, id), new Date());
  }

  /**
   * A person fills in or changes values of an open draft, at the version they read: the values
   * are checked as on create, and the version moves on. The request the assistant sent (its
   * payload hash) stays the draft's, so a replay of that create still finds this draft.
   */
  async update(user: AuthUser, id: string, input: TripDraftUpdateRequest): Promise<TripDraftDto> {
    this.drafts.requireHuman(user, HUMAN_ONLY);
    const current = await this.findScoped(user, id);
    const { version, ...patch } = input;
    requireOpen(current, version, LABEL);
    const costs = patch.agreedCost !== undefined || patch.currency !== undefined;
    if (costs && !seesTransportCosts((p) => user.permissions.has(p))) {
      throw new ForbiddenException('You may not see or change transport costs');
    }
    const values = patched(requestOf(current), patch);
    const prepared = await this.validate(user, values);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockDraftRow(tx, 'trip_drafts', id);
      if (!locked) throw new NotFoundException('Trip draft not found');
      requireOpen(locked, version, LABEL);
      // The user still holds the draft's branch now, as stored.
      await requireBranchMemberInTx(tx, user, current.branchId);
      await tx.tripDraft.update({
        where: { id },
        data: {
          kind: values.kind ?? null,
          originLocationId: values.originLocationId ?? null,
          destinationLocationId: values.destinationLocationId ?? null,
          plannedDeparture: prepared.plannedDeparture,
          plannedArrival: prepared.plannedArrival,
          vehicleId: values.vehicleId ?? null,
          driverId: values.driverId ?? null,
          carrierId: values.carrierId ?? null,
          agreedCost: values.agreedCost ? dec(values.agreedCost) : null,
          currency: values.currency ?? null,
          externalVehicle: values.externalVehicle ?? null,
          externalDriver: values.externalDriver ?? null,
          notes: values.notes ?? null,
          version: { increment: 1 },
        },
      });
      if (patch.shipmentIds !== undefined) {
        await tx.tripDraftShipment.deleteMany({ where: { draftId: id } });
        await tx.tripDraftShipment.createMany({
          data: values.shipmentIds.map((shipmentId, i) => ({
            draftId: id,
            lineNo: i + 1,
            shipmentId,
          })),
        });
      }
    });
    return this.get(user, id);
  }

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.tripDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...draftScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Trip draft not found');
    return toSummary(draft, new Date());
  }

  async list(
    user: AuthUser,
    status?: DraftStatus,
    mine?: MyDraftsQuery,
  ): Promise<TripDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.tripDraft.findMany({
      where: {
        ...draftScope(user),
        ...stateFilter(status, now),
        ...(mine ? mineWhere(user, mine) : {}),
      },
      include: details,
      orderBy: MY_DRAFTS_ORDER,
      take: mine?.limit ?? 200,
    });
    const routes = await this.routeNames(drafts);
    return drafts.map((d) => ({
      ...baseFields(d, user, now, routes),
      lineCount: d.shipments.length,
    }));
  }

  /** "My drafts": this kind's drafts the assistant made for this user, if the user may see them. */
  async mine(user: AuthUser, query: MyDraftsQuery): Promise<MyDraftRow[]> {
    if (!user.permissions.has('transport_trips:view')) return [];
    const drafts = await this.list(user, query.status, query);
    return drafts.map((d) =>
      myDraftItem(
        'trip',
        d,
        d.tripId === null
          ? null
          : { type: 'trip', id: d.tripId, number: d.tripNumber, path: `/trips/${d.tripId}` },
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<TripDraftDto> {
    return withReplacedBy(this.prisma, 'trip_drafts', await this.read(user, id));
  }

  private async read(user: AuthUser, id: string): Promise<TripDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    // Trip costs are Restricted (annex A): hidden from those who may not see them, as on a trip.
    const showsCost = seesTransportCosts((p) => user.permissions.has(p));
    let check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    const request: TripDraftValues = requestOf(draft);
    if (!showsCost) {
      request.agreedCost = null;
      request.currency = null;
      if (check?.ok) check = { ok: true, total: null, currency: null };
    }
    // Only the names and numbers the reviewer can see.
    const shipmentIds = shipmentIdsOf(draft);
    const [visible, vehicle, driverRow, carrier] = await Promise.all([
      this.prisma.shipment.findMany({
        where: { id: { in: shipmentIds }, ...shipmentScope(user) },
        select: { id: true, number: true },
      }),
      draft.vehicleId
        ? this.prisma.vehicle.findFirst({
            where: { id: draft.vehicleId, ...branchScope(user) },
            select: { plateNumber: true },
          })
        : null,
      draft.driverId
        ? this.prisma.driver.findFirst({
            where: { id: draft.driverId, ...branchScope(user) },
            select: { name: true },
          })
        : null,
      draft.carrierId
        ? this.prisma.carrier.findUnique({
            where: { id: draft.carrierId },
            select: { name: true },
          })
        : null,
    ]);
    const numbers = new Map(visible.map((s) => [s.id, s.number]));
    return {
      ...baseFields(draft, user, now, await this.routeNames([draft])),
      request,
      shipmentNumbers: shipmentIds.map((sid) => numbers.get(sid) ?? '—'),
      vehiclePlate: vehicle?.plateNumber ?? null,
      driverName: driverRow?.name ?? null,
      carrierName: carrier?.name ?? null,
      check,
    };
  }

  /**
   * A person approves the version they reviewed: the trip is planned through TripsService in the
   * same transaction as the approval. Approving an approved draft returns it as it is.
   */
  async approve(
    user: AuthUser,
    id: string,
    version: number,
    via: DecisionVia = 'SESSION',
  ): Promise<TripDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    const current = await this.findScoped(user, id);
    if (current.state === 'APPROVED') return this.get(user, id);
    requireOpen(current, version, LABEL);
    // Nothing is recorded while the draft misses a value (422, naming each one).
    requireApprovable(tripCompleteness(requestOf(current)));
    const prepared = await this.trips.prepareCreate(user, completeTrip(requestOf(current)));
    await this.prisma.$transaction(async (tx) => {
      let tripId = '';
      const decided = await decideInTx(tx, {
        table: 'trip_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
        gate: async () => {
          const row = await tx.tripDraft.findUniqueOrThrow({ where: { id }, include: details });
          requireApprovable(tripCompleteness(requestOf(row)));
        },
        record: async () => {
          tripId = await this.trips.insertInTx(tx, user, prepared);
        },
      });
      if (decided) {
        await tx.tripDraft.update({
          where: { id },
          data: { ...approvedFields(user, decidedVia(via)), tripId },
        });
      }
    });
    return this.get(user, id);
  }

  /** The draft as the assistant's chat card shows it (erp-agents docs/chat-draft-approval.md). */
  async forAssistant(user: AuthUser, id: string): Promise<AssistantDraftDto<TripDraftDto>> {
    const draft = await this.get(user, id);
    return this.drafts.assistantView(user, 'trip', 'trip_drafts', draft, LABEL);
  }

  /** A person approves in the assistant's chat the content the card showed them. */
  async approveFromAssistant(
    user: AuthUser,
    id: string,
    input: AssistantDraftApproveRequest,
  ): Promise<TripDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'trip',
      'trip_drafts',
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
  ): Promise<TripDraftDto> {
    const draft = await this.get(user, id);
    const decision = await this.drafts.authorizeAssistant(
      user,
      'trip',
      'trip_drafts',
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
  ): Promise<TripDraftDto> {
    this.drafts.requireDecider(user, via, HUMAN_ONLY, id);
    await this.findScoped(user, id);
    await this.prisma.$transaction(async (tx) => {
      await decideInTx(tx, {
        table: 'trip_drafts',
        id,
        version: input.version,
        label: LABEL,
        approving: false,
      });
      await tx.tripDraft.update({
        where: { id },
        data: rejectedFields(user, input.reason, decidedVia(via)),
      });
    });
    return this.get(user, id);
  }

  /**
   * NOLON's checks of a new trip that need no lock (fleet and currency are checked on approval).
   * Null while the draft misses values and those present pass: it waits for them (missingFields).
   */
  private async check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck | null> {
    const values = requestOf(draft);
    if (tripMissingFields(values).length > 0) {
      const present = await checkDraft(async () => {
        await this.trips.checkPresent(user, values);
        return { total: null, currency: null };
      });
      return present.ok ? null : present;
    }
    return checkDraft(async () => {
      await this.trips.prepareCreate(user, completeTrip(values));
      return {
        total: toDecimalStringOrNull(draft.agreedCost),
        currency: draft.currency,
      };
    });
  }

  /** "AEJEA → SDPZU" for each draft's route, from the locations master. */
  private async routeNames(drafts: readonly DraftRow[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        drafts
          .flatMap((d) => [d.originLocationId, d.destinationLocationId])
          .filter((v): v is string => v !== null),
      ),
    ];
    const locations = await this.prisma.location.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true },
    });
    const code = new Map(locations.map((l) => [l.id, l.code]));
    return new Map(
      drafts.map((d) => [
        d.id,
        `${codeOf(code, d.originLocationId)} → ${codeOf(code, d.destinationLocationId)}`,
      ]),
    );
  }

  private async findScoped(user: AuthUser, id: string): Promise<DraftRow> {
    const draft = await this.prisma.tripDraft.findFirst({
      where: { id, ...draftScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Trip draft not found');
    return draft;
  }
}

function toSummary(d: DraftRow, now: Date): EntryDraftSummaryDto {
  return {
    id: d.id,
    status: draftStatus(d.state, d.expiresAt, now),
    version: d.version,
    lineCount: d.shipments.length,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    missingFields: tripMissingFields(requestOf(d)),
  };
}

function baseFields(
  d: DraftRow,
  user: AuthUser,
  now: Date,
  routes: ReadonlyMap<string, string>,
): TripDraftReviewFields {
  const status = draftStatus(d.state, d.expiresAt, now);
  const open = status === 'DRAFT' && !user.agent && user.permissions.has('transport_trips:create');
  return {
    id: d.id,
    replacesDraftId: d.replacesDraftId,
    branchId: d.branchId,
    subject: routes.get(d.id) ?? '',
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
    missingFields: tripMissingFields(requestOf(d)),
    tripId: d.tripId,
    tripNumber: d.trip?.number ?? null,
  };
}

function codeOf(codes: ReadonlyMap<string, string>, id: string | null): string {
  return (id === null ? undefined : codes.get(id)) ?? '?';
}
