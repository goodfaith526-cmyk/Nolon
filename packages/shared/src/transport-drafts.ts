import type { DecimalString } from './currencies.js';
import type { EntryDraftCheck, EntryDraftReviewFields } from './drafts.js';
import type { TripInput } from './transport.js';
import type { GoodsReleaseRequest } from './warehouse.js';

/**
 * Trip and goods release drafts proposed by the staff AI assistant (entry drafts, drafts.ts). A
 * person approves a trip draft, which plans an ordinary trip (PLANNED, its shipments scheduled),
 * or a release draft, which issues a goods release note dated at the approval; or rejects it.
 */

/** POST /trip-drafts: the assistant proposes a trip. */
export interface TripDraftCreateRequest extends TripInput {
  idempotencyKey: string;
}

export interface TripDraftDto extends EntryDraftReviewFields {
  /**
   * The proposed request, as stored; the agreed cost and its currency are null for a reviewer who
   * does not see transport costs (seesTransportCosts).
   */
  request: TripInput;
  /** The shipments' numbers, in the request's order (only those the reviewer can see). */
  shipmentNumbers: string[];
  /** The fleet the draft names, when the reviewer can see it. */
  vehiclePlate: string | null;
  driverName: string | null;
  carrierName: string | null;
  check: EntryDraftCheck | null;
  tripId: string | null;
  tripNumber: string | null;
}

export type TripDraftListItemDto = Omit<
  TripDraftDto,
  'request' | 'check' | 'shipmentNumbers' | 'vehiclePlate' | 'driverName' | 'carrierName'
> & {
  lineCount: number;
};

/** The request of a goods release draft, as stored: released at the approval. */
export type GoodsReleaseDraftRequest = Omit<GoodsReleaseRequest, 'occurredAt'>;

/** POST /release-drafts: the assistant proposes a goods release from a shipment. */
export interface GoodsReleaseDraftCreateRequest extends GoodsReleaseDraftRequest {
  idempotencyKey: string;
  shipmentId: string;
}

export interface GoodsReleaseDraftDto extends EntryDraftReviewFields {
  shipmentId: string;
  shipmentNumber: string;
  warehouseCode: string;
  request: GoodsReleaseDraftRequest;
  check: EntryDraftCheck | null;
  movementId: string | null;
  movementNumber: string | null;
}

export type GoodsReleaseDraftListItemDto = Omit<GoodsReleaseDraftDto, 'request' | 'check'> & {
  lineCount: number;
  packages: number;
  weightKg: DecimalString | null;
};
