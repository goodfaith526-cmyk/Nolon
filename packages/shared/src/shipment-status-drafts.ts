import type {
  DraftEvidence,
  EntryDraftCheck,
  EntryDraftReviewFields,
  EvidenceReviewFields,
} from './drafts.js';
import type { ShipmentStatus } from './shipments.js';

/**
 * A shipment status change the staff assistant proposes (entry drafts, drafts.ts). A person
 * approves it on the review screen, which applies it through the shipment state machine, dated at
 * the approval, with their own permissions; or rejects it. Closing, holding and cancelling a
 * shipment stay a person's own actions.
 */
export const SHIPMENT_STATUS_DRAFT_EXCLUDED = ['CLOSED', 'ON_HOLD', 'CANCELLED'] as const;

export interface ShipmentStatusDraftRequest {
  status: ShipmentStatus;
  locationId?: string | null;
  note?: string | null;
}

/** POST /shipment-status-drafts. */
export interface ShipmentStatusDraftCreateRequest extends ShipmentStatusDraftRequest {
  idempotencyKey: string;
  shipmentId: string;
  evidence?: DraftEvidence[];
}

export interface ShipmentStatusDraftDto extends EntryDraftReviewFields, EvidenceReviewFields {
  shipmentId: string;
  shipmentNumber: string;
  /** The shipment's status now, to read the proposed move against. */
  currentStatus: ShipmentStatus;
  locationName: string | null;
  request: ShipmentStatusDraftRequest;
  check: EntryDraftCheck | null;
}

export type ShipmentStatusDraftListItemDto = Omit<
  ShipmentStatusDraftDto,
  'request' | 'check' | 'evidence'
> & {
  lineCount: number;
  /** The proposed status (status is the draft's). */
  targetStatus: ShipmentStatus;
};
