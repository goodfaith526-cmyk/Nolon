import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MAX_POD_PHOTOS,
  type PodDto,
  type PodFields,
  type ShipmentPodsDto,
  type ShipmentStatus,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { todayIn } from '../common/dates.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { DocumentsService, type PreparedUpload } from '../documents/documents.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive } from '../shipments/state-machine.js';
import { isDriverOnly, tripScope } from './trip-scope.js';
import { defaultPodStatus, podStatusOptions } from './transport-rules.js';

const podDetails = {
  trip: { select: { number: true } },
  createdBy: { select: { fullName: true } },
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
 * their own trips.
 */
@Injectable()
export class PodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly documents: DocumentsService,
  ) {}

  async view(user: AuthUser, shipmentId: string): Promise<ShipmentPodsDto> {
    const shipment = await this.shipments.childContext(user, shipmentId);
    const [pods, trips] = await Promise.all([
      this.prisma.proofOfDelivery.findMany({
        where: { shipmentId, ...branchScope(user) },
        include: podDetails,
        orderBy: { deliveredAt: 'asc' },
      }),
      this.tripsOf(user, shipmentId),
    ]);
    const canRecord =
      user.permissions.has('pod:create') &&
      user.permissions.has('documents:create') &&
      recordable(shipment.status);
    const statuses = canRecord ? podStatusOptions(shipment.transitions) : [];
    return {
      pods: pods.map(toDto),
      actions: {
        canRecord,
        statuses,
        defaultStatus: defaultPodStatus(statuses),
        trips,
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
      // Exclusive: the status may change in this transaction; a cancel or another POD waits.
      const status = await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      if (!recordable(status)) {
        throw new ConflictException(`A ${status} shipment takes no proof of delivery`);
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
          })
        : false;
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
      where: { id, ...branchScope(user) },
      include: podDetails,
    });
    return toDto(pod);
  }

  /** Trips of this shipment the user may record a POD against (a driver: their own). */
  private async tripsOf(
    user: AuthUser,
    shipmentId: string,
  ): Promise<{ id: string; number: string }[]> {
    return this.prisma.trip.findMany({
      where: {
        ...tripScope(user),
        status: { not: 'CANCELLED' },
        shipments: { some: { shipmentId } },
      },
      select: { id: true, number: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The trip a POD refers to: the one given, which must carry the shipment and be visible to the
   * user (400 otherwise); for a driver who gives none, their latest trip carrying it.
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
      if (!own) throw new NotFoundException('Shipment not found');
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
  };
}
