import { Injectable, NotFoundException } from '@nestjs/common';
import { seesTransportCosts } from '@nolon/shared';
import type {
  AssistantDraftApproveRequest,
  AssistantDraftDto,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftSummaryDto,
  TripDraftCreateRequest,
  TripDraftDto,
  TripDraftListItemDto,
  TripInput,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { dec, toDecimalStringOrNull } from '../common/money.js';
import {
  approvedFields,
  checkDraft,
  decimalKey,
  draftExpiry,
  draftStatus,
  rejectedFields,
  requestHash,
  requireOpen,
  stateFilter,
} from '../drafts/draft-rules.js';
import {
  type DecisionVia,
  DraftsService,
  decidedVia,
  decideInTx,
  keyReused,
} from '../drafts/drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { shipmentScope } from '../shipments/shipment-scope.js';
import { forbidDriverOnly } from './trip-scope.js';
import { TripsService } from './trips.service.js';

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

/** The trip request a stored draft proposes, in the shape TripsService takes. */
export function requestOf(d: DraftRow): TripInput {
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
    shipmentIds: d.shipments.map((s) => s.shipmentId),
  };
}

/** sha256 of the normalised request: ids lower case, times and decimals canonical, keys sorted. */
export function tripRequestHash(input: TripInput): string {
  const lower = (v: string | null | undefined) => v?.toLowerCase() ?? null;
  const time = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);
  return requestHash({
    branchId: input.branchId.toLowerCase(),
    kind: input.kind,
    originLocationId: input.originLocationId.toLowerCase(),
    destinationLocationId: input.destinationLocationId.toLowerCase(),
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

  async create(user: AuthUser, body: TripDraftCreateRequest): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    draftScope(user);
    const { idempotencyKey, ...input } = body;
    // The checks of a real trip that need no lock; nothing is written.
    const prepared = await this.trips.prepareCreate(user, input);
    const hash = tripRequestHash(input);
    const scope = { agentClientId, createdById: user.id, idempotencyKey };
    const id = await this.drafts.createIdempotently(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.tripDraft.findUnique({
          where: { agentClientId_createdById_idempotencyKey: scope },
          select: { id: true, payloadHash: true },
        });
        if (existing) {
          if (existing.payloadHash !== hash) throw keyReused();
          return existing.id;
        }
        const draft = await tx.tripDraft.create({
          data: {
            ...scope,
            branchId: input.branchId,
            expiresAt: draftExpiry(),
            payloadHash: hash,
            kind: input.kind,
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
          data: prepared.shipmentIds.map((shipmentId, i) => ({
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

  async findByKey(user: AuthUser, idempotencyKey: string): Promise<EntryDraftSummaryDto> {
    const agentClientId = await this.drafts.agentClientOf(user, ASSISTANT_ONLY);
    const draft = await this.prisma.tripDraft.findFirst({
      where: { agentClientId, createdById: user.id, idempotencyKey, ...draftScope(user) },
      include: details,
    });
    if (!draft) throw new NotFoundException('Trip draft not found');
    return toSummary(draft, new Date());
  }

  async list(user: AuthUser, status?: DraftStatus): Promise<TripDraftListItemDto[]> {
    const now = new Date();
    const drafts = await this.prisma.tripDraft.findMany({
      where: { ...draftScope(user), ...stateFilter(status, now) },
      include: details,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const routes = await this.routeNames(drafts);
    return drafts.map((d) => ({
      ...baseFields(d, user, now, routes),
      lineCount: d.shipments.length,
    }));
  }

  async get(user: AuthUser, id: string): Promise<TripDraftDto> {
    const draft = await this.findScoped(user, id);
    const now = new Date();
    // Trip costs are Restricted (annex A): hidden from those who may not see them, as on a trip.
    const showsCost = seesTransportCosts((p) => user.permissions.has(p));
    let check =
      draftStatus(draft.state, draft.expiresAt, now) === 'DRAFT'
        ? await this.check(user, draft)
        : null;
    const request = requestOf(draft);
    if (!showsCost) {
      request.agreedCost = null;
      request.currency = null;
      if (check?.ok) check = { ok: true, total: null, currency: null };
    }
    // Only the names and numbers the reviewer can see.
    const shipmentIds = draft.shipments.map((s) => s.shipmentId);
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
    const prepared = await this.trips.prepareCreate(user, requestOf(current));
    await this.prisma.$transaction(async (tx) => {
      let tripId = '';
      const decided = await decideInTx(tx, {
        table: 'trip_drafts',
        id,
        version,
        label: LABEL,
        approving: true,
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

  /** NOLON's checks of a new trip that need no lock (fleet and currency are checked on approval). */
  private check(user: AuthUser, draft: DraftRow): Promise<EntryDraftCheck> {
    return checkDraft(async () => {
      await this.trips.prepareCreate(user, requestOf(draft));
      return {
        total: toDecimalStringOrNull(draft.agreedCost),
        currency: draft.currency,
      };
    });
  }

  /** "AEJEA → SDPZU" for each draft's route, from the locations master. */
  private async routeNames(drafts: readonly DraftRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(drafts.flatMap((d) => [d.originLocationId, d.destinationLocationId]))];
    const locations = await this.prisma.location.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true },
    });
    const code = new Map(locations.map((l) => [l.id, l.code]));
    return new Map(
      drafts.map((d) => [
        d.id,
        `${code.get(d.originLocationId) ?? '?'} → ${code.get(d.destinationLocationId) ?? '?'}`,
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
    actions: { canEdit: false, canDecide: open },
    tripId: d.tripId,
    tripNumber: d.trip?.number ?? null,
  };
}
