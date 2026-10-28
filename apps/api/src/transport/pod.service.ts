import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  MAX_POD_PHOTOS,
  type PodDto,
  type PodFields,
  type ShipmentPodsDto,
  type ShipmentStatus,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { shipmentScope, holdsOnShipment } from '../shipments/shipment-scope.js';
import { todayIn } from '../common/dates.js';
import { codedRefusal } from '../common/validation.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { DocumentsService, type PreparedUpload } from '../documents/documents.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentLinksRegistry } from '../shipments/shipment-links.registry.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive } from '../shipments/state-machine.js';
import { isDriverOnly, lockTripShared, tripScope } from './trip-scope.js';
import {
  POD_TRIP_STATUSES,
  defaultPodStatus,
  podStatusOptions,
  tripTakesPod,
} from './transport-rules.js';

const podDetails = {
  trip: { select: { number: true } },
  createdBy: { select: { fullName: true } },
  cancellation: { include: { cancelledBy: { select: { fullName: true } } } },
  photos: {
    where: { document: { deletedAt: null } },
    include: { document: { select: { id: true, fileName: true, uploadedAt: true } } },
  },
} satisfies Prisma.ProofOfDeliveryInclude;

type PodWithDetails = Prisma.ProofOfDeliveryGetPayload<{ include: typeof podDetails }>;

/** A delivery may be recorded after the fact, but not ahead of the clock (small skew ok). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** The signature is a shipment document of type POD; the photos of type PHOTO. */
const SIGNATURE_TYPE = 'POD';
const PHOTO_TYPE = 'PHOTO';

export interface PodUpload {
  fileName: string;
  data: Buffer;
}

/**
 * Proof of delivery (scope 12, annex B: one POD per delivery batch): recipient and capacity, the
 * time, photos and the on-screen signature, stored as shipment documents. Recording a POD can
 * move the shipment to PARTIALLY_DELIVERED or DELIVERED through the state machine, in the same
 * transaction, when that move is allowed now; otherwise it only records the delivery. A Driver
 * records PODs only for shipments on their own trips (ShipmentsService scope) and only against
 * their own trips. The trip a POD names is share-locked and checked again inside the transaction,
 * before the shipment lock (the trip service's order): it must still carry the shipment, have
 * left and not be cancelled, and for a driver still be theirs. A delivery is never dated before
 * the shipment's latest event.
 */
@Injectable()
export class PodService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly documents: DocumentsService,
    private readonly shipmentLinks: ShipmentLinksRegistry,
  ) {}

  onModuleInit(): void {
    // B2: the status a proof of delivery applied is not undone from the shipment.
    this.shipmentLinks.register({
      revertBlockerInTx: async (tx, shipmentId, step) => {
        if (step.note === null) return null;
        const pod = await tx.proofOfDelivery.findFirst({
          where: { shipmentId, number: step.note, statusApplied: step.status, cancellation: null },
          select: { number: true },
        });
        return pod ? { record: 'POD', number: pod.number } : null;
      },
      // B3: a proof of delivery that kept the status moved the shipment to where it was delivered
      // (record): the trip's destination, or without a trip the shipment's. Neither changes once
      // set, so the place is the one the POD recorded.
      locationEffectsInTx: async (tx, shipmentId) => {
        const pods = await tx.proofOfDelivery.findMany({
          where: { shipmentId, statusApplied: null, cancellation: null },
          select: {
            deliveredAt: true,
            createdAt: true,
            trip: { select: { destinationLocationId: true } },
            shipment: { select: { destinationLocationId: true } },
          },
        });
        return pods.map((p) => ({
          at: p.deliveredAt,
          createdAt: p.createdAt,
          locationId: p.trip?.destinationLocationId ?? p.shipment.destinationLocationId,
        }));
      },
    });
  }

  async view(user: AuthUser, shipmentId: string): Promise<ShipmentPodsDto> {
    const shipment = await this.shipments.childContext(user, shipmentId);
    const [pods, trips] = await Promise.all([
      this.prisma.proofOfDelivery.findMany({
        where: {
          shipmentId,
          shipment: shipmentScope(user),
          // The assistant's field list knows no cancelled POD: it sees the live ones only.
          ...(user.agent ? { cancellation: null } : {}),
        },
        include: podDetails,
        orderBy: { deliveredAt: 'asc' },
      }),
      this.tripsOf(user, shipmentId),
    ]);
    const canRecord =
      holdsOnShipment(user, 'pod:create', shipment) &&
      holdsOnShipment(user, 'documents:create', shipment) &&
      recordable(shipment.status) &&
      // A driver records against one of their trips, so one must have left.
      (!isDriverOnly(user) || trips.length > 0);
    const statuses = canRecord ? podStatusOptions(shipment.transitions) : [];
    return {
      pods: pods.map(toDto),
      actions: {
        canRecord,
        statuses,
        defaultStatus: defaultPodStatus(statuses),
        trips,
        // The cancel's own rule (F133-1): not offered to a branch that only shares the shipment.
        canCancel:
          !user.agent && mayCancelPods(user, shipment.branchId) && shipment.status !== 'CLOSED',
      },
    };
  }

  async record(
    user: AuthUser,
    shipmentId: string,
    fields: PodFields,
    signature: PodUpload,
    photos: readonly PodUpload[],
  ): Promise<PodDto> {
    const shipment = await this.shipments.requireAccessible(user, shipmentId);
    if (!recordable(shipment.status)) {
      throw new ConflictException(`A ${shipment.status} shipment takes no proof of delivery`);
    }
    if (photos.length > MAX_POD_PHOTOS) {
      throw new BadRequestException(`At most ${MAX_POD_PHOTOS} photos`);
    }
    const deliveredAt = fields.deliveredAt ? new Date(fields.deliveredAt) : new Date();
    if (deliveredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new BadRequestException('The delivery time cannot be in the future');
    }
    const tripId = await this.resolveTrip(user, shipmentId, fields.tripId ?? null);
    const signatureFile = await this.documents.prepare({
      typeCode: SIGNATURE_TYPE,
      fileName: signature.fileName,
      note: null,
      data: signature.data,
    });
    if (signatureFile.contentType !== 'image/png') {
      throw new BadRequestException('The signature is a PNG image');
    }
    const photoFiles: PreparedUpload[] = [];
    for (const photo of photos) {
      const file = await this.documents.prepare({ typeCode: PHOTO_TYPE, note: null, ...photo });
      if (!file.contentType.startsWith('image/')) {
        throw new BadRequestException('Only JPEG, PNG and WebP photos are accepted');
      }
      photoFiles.push(file);
    }
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: shipment.branchId },
      select: { timezone: true },
    });
    const id = await this.prisma.$transaction(async (tx) => {
      const tripTo = tripId ? await this.requireTripInTx(tx, user, tripId, shipmentId) : null;
      // Exclusive: the status may change in this transaction; a cancel or another POD waits.
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (!recordable(status)) {
        throw new ConflictException(`A ${status} shipment takes no proof of delivery`);
      }
      // Delivered at the trip's destination, or without a trip at the shipment's.
      const deliveredTo = tripTo ?? (await this.shipments.destinationInTx(tx, shipmentId));
      const { lastEventAt } = await this.shipments.branchAndLastEventInTx(tx, shipmentId);
      if (lastEventAt && deliveredAt < lastEventAt) {
        throw new BadRequestException(
          `The delivery cannot be dated before the shipment's latest event (${lastEventAt.toISOString()})`,
        );
      }
      const year = todayIn(branch.timezone).slice(0, 4);
      const number = formatDocumentNumber('POD', await nextSequenceValue(tx, 'POD', year), year);
      const signed = await this.documents.insert(tx, user, shipment.branchId, shipmentId, {
        ...signatureFile,
        note: number,
      });
      const applied = fields.shipmentStatus
        ? await this.shipments.advanceInTx(tx, user, shipmentId, fields.shipmentStatus, {
            occurredAt: deliveredAt,
            note: number,
            locationId: deliveredTo,
          })
        : false;
      // Delivered there whether or not the status changed ("keep the status"): the tracking
      // page follows the goods.
      if (!applied) await this.shipments.relocateInTx(tx, shipmentId, deliveredTo);
      const pod = await tx.proofOfDelivery.create({
        data: {
          number,
          branchId: shipment.branchId,
          shipmentId,
          tripId,
          recipientName: fields.recipientName,
          recipientCapacity: fields.recipientCapacity,
          deliveredAt,
          packages: fields.packages ?? null,
          note: fields.note ?? null,
          statusApplied: applied ? (fields.shipmentStatus ?? null) : null,
          signatureDocumentId: signed.id,
          createdById: user.id,
        },
        select: { id: true },
      });
      for (const file of photoFiles) {
        const document = await this.documents.insert(tx, user, shipment.branchId, shipmentId, {
          ...file,
          note: number,
        });
        await tx.podPhoto.create({
          data: { podId: pod.id, documentId: document.id, branchId: shipment.branchId },
        });
      }
      return pod.id;
    });
    const pod = await this.prisma.proofOfDelivery.findFirstOrThrow({
      where: { id, shipment: shipmentScope(user) },
      include: podDetails,
    });
    return toDto(pod);
  }

  /**
   * Cancels a proof of delivery (B3-2, docs/plans/05-correction-contracts.md, section 2). The POD,
   * its signature and photos stay; a cancellation row is linked to it and from then on it stands
   * for no delivery. pod:cancel in the POD's branch. Locks as recording does: the trip shared, then
   * the shipment exclusively. Refused (409) on a closed shipment, when a later live POD of the
   * shipment exists (cancel that one first), and when the shipment moved on since: a later step, or
   * for a POD that kept the status, another place. The status it applied is undone while it is
   * the current step; the place goes back to the latest left on the location timeline, an earlier
   * POD that kept the status included (F132-4). Cancelling again for the same reason returns it;
   * for another reason it is refused.
   */
  async cancel(user: AuthUser, shipmentId: string, podId: string, reason: string): Promise<PodDto> {
    const found = await this.prisma.proofOfDelivery.findFirst({
      where: { id: podId, shipmentId, shipment: shipmentScope(user) },
      include: {
        trip: { select: { destinationLocationId: true } },
        shipment: { select: { destinationLocationId: true } },
      },
    });
    if (!found) throw new NotFoundException('Proof of delivery not found');
    if (!mayCancelPods(user, found.branchId)) {
      throw new ForbiddenException('You may not cancel proofs of delivery of this branch');
    }
    const label = { pod: found.number };
    await this.prisma.$transaction(async (tx) => {
      if (found.tripId) await lockTripShared(tx, found.tripId);
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      const done = await tx.podCancellation.findUnique({
        where: { podId },
        select: { reason: true },
      });
      if (done) {
        if (done.reason === reason) return;
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'CORRECTION_ALREADY_DONE',
          `Proof of delivery ${found.number} was already cancelled for another reason`,
          { record: found.number },
        );
      }
      if (status === 'CLOSED') {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'POD_CANCEL_CLOSED',
          `Shipment is closed: proof of delivery ${found.number} cannot be cancelled`,
          label,
        );
      }
      const later = await tx.proofOfDelivery.findFirst({
        where: {
          shipmentId,
          id: { not: podId },
          cancellation: null,
          OR: [
            { deliveredAt: { gt: found.deliveredAt } },
            { deliveredAt: found.deliveredAt, createdAt: { gt: found.createdAt } },
          ],
        },
        select: { number: true },
        orderBy: [{ deliveredAt: 'asc' }, { createdAt: 'asc' }],
      });
      if (later) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'POD_CANCEL_LATER_POD',
          `Proof of delivery ${later.number} came after ${found.number}: cancel it first`,
          { ...label, later: later.number },
        );
      }
      // Out of the location timeline from here on (locationEffectsInTx reads live PODs only).
      await tx.podCancellation.create({
        data: { podId, branchId: found.branchId, reason, cancelledById: user.id },
      });
      const moved = () =>
        codedRefusal(
          HttpStatus.CONFLICT,
          'POD_CANCEL_STATUS_MOVED',
          `The shipment moved on since proof of delivery ${found.number}: undo the later steps first`,
          label,
        );
      if (found.statusApplied) {
        // Its step carried its place; a step undone before already took both back.
        await this.shipments.undoRecordStepInTx(
          tx,
          user,
          shipmentId,
          { status: found.statusApplied, numbers: [found.number], reason },
          moved,
        );
      } else {
        await this.shipments.unplaceRecordInTx(
          tx,
          shipmentId,
          {
            at: found.deliveredAt,
            createdAt: found.createdAt,
            locationId: found.trip?.destinationLocationId ?? found.shipment.destinationLocationId,
          },
          moved,
        );
      }
    });
    const pod = await this.prisma.proofOfDelivery.findFirstOrThrow({
      where: { id: podId, shipment: shipmentScope(user) },
      include: podDetails,
    });
    return toDto(pod);
  }

  /**
   * Inside the POD's transaction, before the shipment lock: the trip, share-locked, still carries
   * the shipment, has departed (or arrived, or completed) and is not cancelled (409); a driver's
   * trip is still assigned to them (404, as for any trip that is not theirs). Returns the trip's
   * destination, where the shipment is delivered.
   */
  private async requireTripInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    tripId: string,
    shipmentId: string,
  ): Promise<string> {
    const trip = await lockTripShared(tx, tripId);
    if (isDriverOnly(user) && trip.driverUserId !== user.id) {
      throw new NotFoundException('Trip not found');
    }
    const link = await tx.tripShipment.findUnique({
      where: { tripId_shipmentId: { tripId, shipmentId } },
      select: { tripId: true },
    });
    if (!link || trip.status === 'CANCELLED') {
      throw new ConflictException('The trip no longer carries this shipment');
    }
    if (!tripTakesPod(trip.status)) {
      throw new ConflictException('A proof of delivery is recorded once the trip has departed');
    }
    return trip.destinationLocationId;
  }

  /**
   * Trips of this shipment the user may record a POD against (a driver: their own): those that
   * have left (tripTakesPod), latest first.
   */
  private async tripsOf(
    user: AuthUser,
    shipmentId: string,
  ): Promise<{ id: string; number: string }[]> {
    return this.prisma.trip.findMany({
      where: {
        ...tripScope(user),
        status: { in: [...POD_TRIP_STATUSES] },
        shipments: { some: { shipmentId } },
      },
      select: { id: true, number: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The trip a POD refers to: the one given, which must carry the shipment, have left and be
   * visible to the user (400 otherwise); for a driver who gives none, their latest such trip.
   * Checked again under the trip lock (requireTripInTx).
   */
  private async resolveTrip(
    user: AuthUser,
    shipmentId: string,
    tripId: string | null,
  ): Promise<string | null> {
    const trips = await this.tripsOf(user, shipmentId);
    if (tripId) {
      if (!trips.some((t) => t.id === tripId)) {
        throw new BadRequestException('The trip does not carry this shipment');
      }
      return tripId;
    }
    if (isDriverOnly(user)) {
      const own = trips[0];
      if (!own) {
        throw new ConflictException('A proof of delivery is recorded once the trip has departed');
      }
      return own.id;
    }
    return null;
  }
}

/** A POD is recorded while the shipment is under way: not on hold, delivered, closed or cancelled. */
function recordable(status: ShipmentStatus): boolean {
  return isActive(status) && status !== 'ON_HOLD' && status !== 'DELIVERED';
}

function toDto(p: PodWithDetails): PodDto {
  return {
    id: p.id,
    number: p.number,
    shipmentId: p.shipmentId,
    tripId: p.tripId,
    tripNumber: p.trip?.number ?? null,
    recipientName: p.recipientName,
    recipientCapacity: p.recipientCapacity,
    deliveredAt: p.deliveredAt.toISOString(),
    packages: p.packages,
    note: p.note,
    statusApplied:
      p.statusApplied === 'PARTIALLY_DELIVERED' || p.statusApplied === 'DELIVERED'
        ? p.statusApplied
        : null,
    signatureDocumentId: p.signatureDocumentId,
    photos: [...p.photos]
      .sort((a, b) => a.document.uploadedAt.getTime() - b.document.uploadedAt.getTime())
      .map((ph) => ({ documentId: ph.document.id, fileName: ph.document.fileName })),
    createdByName: p.createdBy.fullName,
    cancellation: p.cancellation
      ? {
          reason: p.cancellation.reason,
          cancelledAt: p.cancellation.cancelledAt.toISOString(),
          cancelledByName: p.cancellation.cancelledBy.fullName,
        }
      : null,
  };
}

/**
 * pod:cancel in the branch that owns the PODs (the shipment's own branch, where every POD is
 * recorded): the cancel and the button that offers it (F133-1).
 */
function mayCancelPods(user: AuthUser, branchId: string): boolean {
  return user.access.has('pod:cancel', branchId);
}
