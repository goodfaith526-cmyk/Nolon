import type {
  DraftBranchChoice,
  DraftEvidence,
  DraftUpdateRequest,
  EntryDraftCheck,
  EntryDraftReviewFields,
  EvidenceReviewFields,
  MissingFieldsReview,
} from './drafts.js';
import type { ShipmentStatus } from './shipments.js';

/**
 * A shipment status change the staff assistant proposes (entry drafts, drafts.ts). A person
 * approves it on the review screen, which applies it through the shipment state machine, dated at
 * the approval, with their own permissions; or rejects it. Closing, holding and cancelling a
 * shipment stay a person's own actions. The statuses a record of their own sets (goods receipt,
 * consolidation, customs file, proof of delivery: EVENT_BOUND_SHIPMENT_STATUSES) are never
 * proposed (functional review Z1, E7); the road statuses a trip sets may be, and are refused for a
 * shipment on an open trip when the draft is checked and approved (isManualShipmentStatus).
 */
export const SHIPMENT_STATUS_DRAFT_EXCLUDED = [
  'CLOSED',
  'ON_HOLD',
  'CANCELLED',
  'RECEIVED_ORIGIN_WAREHOUSE',
  'CONSOLIDATED',
  'CUSTOMS_IN_PROGRESS',
  'CUSTOMS_CLEARED',
  'RECEIVED_DESTINATION_WAREHOUSE',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
] as const satisfies readonly ShipmentStatus[];

/** A status change as its draft holds it: the status may be missing until a person fills it in. */
export interface ShipmentStatusDraftRequest {
  status?: ShipmentStatus | null;
  locationId?: string | null;
  note?: string | null;
}

/**
 * POST /shipment-status-drafts: no value required. With no shipment yet, the draft names its
 * branch.
 */
export interface ShipmentStatusDraftCreateRequest
  extends ShipmentStatusDraftRequest, DraftBranchChoice {
  idempotencyKey: string;
  shipmentId?: string | null;
  evidence?: DraftEvidence[];
}

/** PATCH /shipment-status-drafts/:id: a shipment named must be of the draft's branch. */
export type ShipmentStatusDraftUpdateRequest = DraftUpdateRequest<
  ShipmentStatusDraftRequest & { shipmentId: string | null }
>;

export interface ShipmentStatusDraftDto
  extends EntryDraftReviewFields, EvidenceReviewFields, MissingFieldsReview {
  /** Null while the draft names no shipment yet. */
  shipmentId: string | null;
  shipmentNumber: string | null;
  /** The shipment's status now, to read the proposed move against (null with no shipment). */
  currentStatus: ShipmentStatus | null;
  locationName: string | null;
  request: ShipmentStatusDraftRequest;
  check: EntryDraftCheck | null;
}

export type ShipmentStatusDraftListItemDto = Omit<
  ShipmentStatusDraftDto,
  'request' | 'check' | 'evidence'
> & {
  lineCount: number;
  /** The proposed status (status is the draft's); null while missing. */
  targetStatus: ShipmentStatus | null;
};
