import type {
  BookingService,
  CargoType,
  DateString,
  LoadType,
  Page,
  ShippingMode,
} from './commercial.js';

/**
 * Shipment cycle (scope 8, annex B section 4). Internal statuses are what staff work with; the
 * public tracking page shows the coarser PUBLIC_SHIPMENT_STATUSES only.
 */

export const SHIPMENT_STATUSES = [
  'CREATED',
  'PICKUP_SCHEDULED',
  'RECEIVED_ORIGIN_WAREHOUSE',
  'CONSOLIDATED',
  'LOADED',
  'DEPARTED',
  'IN_TRANSIT',
  'ARRIVED_PORT',
  'TRIP_SCHEDULED',
  'ROAD_DEPARTED',
  'ROAD_IN_TRANSIT',
  'ROAD_ARRIVED',
  'CUSTOMS_IN_PROGRESS',
  'CUSTOMS_CLEARED',
  'RECEIVED_DESTINATION_WAREHOUSE',
  'OUT_FOR_DELIVERY',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'CLOSED',
  'ON_HOLD',
  'CANCELLED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_EVENT_KINDS = [
  'CREATED',
  'STATUS',
  'HOLD',
  'RESUME',
  'REVERT',
  'CANCEL',
] as const;
export type ShipmentEventKind = (typeof SHIPMENT_EVENT_KINDS)[number];

export const EVENT_SOURCES = ['USER', 'API', 'SYSTEM'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/**
 * What the customer sees (annex B section 4, "Public" column). Consolidated and Closed are
 * internal: the page keeps showing the status before them.
 */
export const PUBLIC_SHIPMENT_STATUSES = [
  'REGISTERED',
  'PICKUP_IN_PROGRESS',
  'AT_ORIGIN_WAREHOUSE',
  'LOADED',
  'DEPARTED_ORIGIN',
  'IN_TRANSIT_SEA',
  'ARRIVED_PORT',
  'PREPARING_ROAD',
  'DEPARTED_ROAD',
  'IN_TRANSIT_ROAD',
  'ARRIVED_CITY',
  'CUSTOMS_IN_PROGRESS',
  'CUSTOMS_CLEARED',
  'AT_DESTINATION_WAREHOUSE',
  'OUT_FOR_DELIVERY',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'ON_HOLD',
] as const;
export type PublicShipmentStatus = (typeof PUBLIC_SHIPMENT_STATUSES)[number];

/** ISO 6346 container number, e.g. MSCU1234565. */
export const CONTAINER_NUMBER_PATTERN = /^[A-Z]{4}[0-9]{7}$/;

/** Largest accepted document upload. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export interface ShipmentSummaryDto {
  id: string;
  number: string;
  branchId: string;
  /**
   * Other branches that see and work on the shipment besides its own (annex A: origin and
   * destination; a transit branch may join). Billing stays with `branchId`.
   */
  sharedBranchIds: string[];
  customerId: string;
  customerName: string;
  bookingId: string;
  bookingNumber: string;
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  loadType: LoadType | null;
  status: ShipmentStatus;
  eta: DateString | null;
  createdAt: string;
}

/**
 * Shipments to pick for a document of one branch (GET /shipments/pick; functional review C10):
 * those visible in the branch and not cancelled, matching the search on their number or customer.
 * `exact` is the shipment whose number is the search (any case), shown first and left out of
 * `items`, so it is found however many others match; `items` pages through the others by number.
 */
export interface ShipmentPickPage extends Page<ShipmentSummaryDto> {
  exact: ShipmentSummaryDto | null;
}

export interface ShipmentItemDto {
  lineNo: number;
  cargoType: CargoType;
  containerTypeCode: string | null;
  description: string | null;
  quantity: number;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  weightKg: string | null;
  volumeCbm: string | null;
}

export interface ShipmentContainerDto {
  id: string;
  containerNumber: string;
  sealNumber: string | null;
  containerTypeCode: string;
}

export interface ShipmentEventDto {
  id: string;
  kind: ShipmentEventKind;
  status: ShipmentStatus;
  fromStatus: ShipmentStatus | null;
  occurredAt: string;
  branchId: string;
  locationId: string | null;
  userName: string | null;
  source: EventSource;
  note: string | null;
  reason: string | null;
  /** When the event was recorded; `occurredAt` may be entered after the fact. */
  createdAt: string;
}

/** The step a revert undoes (the shipment's current one), shown before the user confirms. */
export interface RevertStepDto {
  /** Sent back as `undoEventId`: the revert is refused (409) if another step came since. */
  eventId: string;
  status: ShipmentStatus;
  occurredAt: string;
  userName: string | null;
  /** Recorded by the signed-in user. */
  byMe: boolean;
}

/** The shortest reason (trimmed) for holding, reverting or cancelling a shipment. */
export const SHIPMENT_REASON_MIN_LENGTH = 3;

/** POST /shipments/:id/revert. */
export interface RevertRequest {
  reason: string;
  undoEventId: string;
}

/**
 * What the signed-in user may do next, decided by the API (state machine, services on the
 * shipment, and the user's permissions). The web shows only these actions.
 */
export interface ShipmentActionsDto {
  transitions: ShipmentStatus[];
  canHold: boolean;
  canResume: boolean;
  /** The status a revert would return to, when the user may revert. */
  revertTo: ShipmentStatus | null;
  /** With revertTo: the step the revert undoes. */
  revertUndoes: RevertStepDto | null;
  /**
   * The closed container whose consolidation is the current step: closing is final, so there is
   * no revert (revertTo is null).
   */
  revertBlockedByContainer: string | null;
  /** The earliest time a status change entered by hand may carry (ISO). */
  earliestStatusTime: string;
  /**
   * For each offered transition that usually happens at the shipment's origin or destination: that
   * location, suggested in the status form (any location may still be chosen).
   */
  suggestedLocations: Partial<Record<ShipmentStatus, string>>;
  /**
   * The shipment travels in a container (not cancelled, not unpacked) whose own moves give it
   * these offered statuses: recording one here by hand is allowed, with a warning to move the
   * container instead.
   */
  containerMoves: { container: string; statuses: ShipmentStatus[] } | null;
  /** With CLOSED among the transitions: what closing needs (B1-5); otherwise null. */
  closeCheck: ShipmentCloseCheckDto | null;
  canCancel: boolean;
  canEdit: boolean;
  /** Only users of the shipment's own branch choose the branches sharing it. */
  canShareBranches: boolean;
}

/**
 * Closing a delivered shipment (owner decision Q1): no goods left in any warehouse, and an
 * approved invoice billing it, or a reason it is closed without charges. Checked again under the
 * shipment's lock when it closes.
 */
export interface ShipmentCloseCheckDto {
  /** Warehouses still holding its goods, with the packages on hand; empty when none. */
  goodsOnHand: { warehouseCode: string; packages: number }[];
  /** An approved invoice bills it (not fully credited, or paid). */
  invoiced: boolean;
}

/** A branch named on a shipment (one sharing it, or one it may be shared with). */
export interface ShipmentBranchDto {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
}

export interface ShipmentDto extends ShipmentSummaryDto {
  cargoType: CargoType;
  cargoDescription: string | null;
  services: BookingService[];
  shipperId: string | null;
  consigneeId: string | null;
  notifyPartyId: string | null;
  statusBeforeHold: ShipmentStatus | null;
  holdReason: string | null;
  cancelReason: string | null;
  currentLocationId: string | null;
  carrierName: string | null;
  vesselName: string | null;
  voyageNumber: string | null;
  blNumber: string | null;
  etd: DateString | null;
  trackingToken: string;
  closedAt: string | null;
  /** Packages on all cargo lines (the sum of their quantities): what the labels number up to. */
  packages: number;
  items: ShipmentItemDto[];
  containers: ShipmentContainerDto[];
  events: ShipmentEventDto[];
  /** The branches in sharedBranchIds, by code. */
  sharedBranches: ShipmentBranchDto[];
  /** When actions.canShareBranches: the active branches the shipment may be shared with. */
  shareableBranches: ShipmentBranchDto[];
  actions: ShipmentActionsDto;
}

/** PATCH /shipments/:id: what may change after creation. Omitted fields stay as they are. */
export interface ShipmentUpdateRequest {
  cargoDescription?: string | null;
  services?: BookingService[];
  shipperId?: string | null;
  consigneeId?: string | null;
  notifyPartyId?: string | null;
  carrierName?: string | null;
  vesselName?: string | null;
  voyageNumber?: string | null;
  blNumber?: string | null;
  etd?: DateString | null;
  eta?: DateString | null;
  /** Replaces the other branches working on the shipment ([] removes them all). */
  sharedBranchIds?: string[];
}

/** At most this many other branches share one shipment. */
export const MAX_SHARED_BRANCHES = 5;

export interface ShipmentStatusRequest {
  status: ShipmentStatus;
  /** Defaults to now; may be earlier when recorded after the fact, never in the future. */
  occurredAt?: string;
  locationId?: string | null;
  note?: string | null;
  /**
   * Closing only: why a shipment no approved invoice bills is closed without charges (at least
   * SHIPMENT_REASON_MIN_LENGTH characters). Recorded as the reason of the closing event; refused
   * on any other status, and when an approved invoice bills the shipment (B1-5).
   */
  noChargeReason?: string | null;
}

export interface ShipmentHoldRequest {
  reason: string;
  note?: string | null;
}

export interface ShipmentContainerInput {
  containerNumber: string;
  sealNumber?: string | null;
  containerTypeCode: string;
}

export interface ShipmentDocumentDto {
  id: string;
  typeCode: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  note: string | null;
  uploadedByName: string;
  uploadedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Public tracking (no sign-in). Only the safe fields of annex B section 6: no names, phones,
// weights, amounts or internal notes.
// ---------------------------------------------------------------------------------------------

export interface PublicLocationDto {
  code: string;
  nameEn: string;
  nameAr: string;
}

export interface PublicTimelineEntryDto {
  status: PublicShipmentStatus;
  occurredAt: string;
  location: PublicLocationDto | null;
}

export interface PublicTrackingDto {
  reference: string;
  mode: ShippingMode;
  status: PublicShipmentStatus;
  origin: PublicLocationDto;
  destination: PublicLocationDto;
  currentLocation: PublicLocationDto | null;
  eta: DateString | null;
  timeline: PublicTimelineEntryDto[];
}

/** POST /public/tracking/lookup: shipment number plus the last 4 digits of a registered phone. */
export interface PublicTrackingLookupRequest {
  reference: string;
  phoneLast4: string;
}

export interface PublicTrackingLookupResponse {
  token: string;
}
