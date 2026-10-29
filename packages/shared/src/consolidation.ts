import type { CreateBookingRequest, DateString } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type { Permission } from './auth.js';
import type { ShipmentStatus } from './shipments.js';

/**
 * Consolidation (annex B): shipments of different customers in one LCL sea container. The
 * container's status moves its shipments (consolidated, loaded, departed, arrived at the port);
 * its supplier bills post to the consolidation clearing account (annex C rule 7a), and closing it
 * shares them between the shipments by CBM or weight (rule 13). Amounts and measures are decimal
 * strings.
 */

export const CONSOLIDATION_STATUSES = [
  'OPEN',
  'CLOSED',
  'LOADED',
  'DEPARTED',
  'ARRIVED',
  'DECONSOLIDATED',
  'CANCELLED',
] as const;
export type ConsolidationStatus = (typeof CONSOLIDATION_STATUSES)[number];

/** The steps a container takes after it is opened, one at a time. */
export const CONSOLIDATION_MOVES = [
  'CLOSED',
  'LOADED',
  'DEPARTED',
  'ARRIVED',
  'DECONSOLIDATED',
] as const;
export type ConsolidationMove = (typeof CONSOLIDATION_MOVES)[number];

/** How the container's cost is shared between its shipments (annex B: CBM by default). */
export const CONSOLIDATION_BASES = ['CBM', 'WEIGHT'] as const;
export type ConsolidationBasis = (typeof CONSOLIDATION_BASES)[number];

/**
 * Container costs are Restricted (annex A "shipment profitability and costs"): only those who see
 * shipment profitability see what a container cost and how it was shared.
 */
export function seesConsolidationCosts(has: (permission: Permission) => boolean): boolean {
  return has('shipment_profitability:view');
}

export interface ConsolidationSummaryDto {
  id: string;
  /** DXB-PTS-C0001 (its route, then C and a serial) */
  number: string;
  branchId: string;
  status: ConsolidationStatus;
  originLocationId: string;
  destinationLocationId: string;
  containerTypeCode: string;
  containerNumber: string | null;
  vesselName: string | null;
  etd: DateString | null;
  eta: DateString | null;
  shipmentCount: number;
  /**
   * How full it is: the higher of its CBM and weight fill (percent, one decimal), from the cargo
   * known now. Null when its type has no limit set.
   */
  fillPercent: DecimalString | null;
  /** True when a limited dimension has cargo whose measure is not entered yet. */
  fillIncomplete: boolean;
}

/** One dimension (CBM or weight) of a container's space. */
export interface ContainerCapacityDimensionDto {
  /** The container type's usable limit; null when none is set (no limit applies). */
  limit: DecimalString | null;
  /** The known load: the sum of the cargo lines that carry this measure. */
  used: DecimalString;
  /** limit - used (negative when over); null without a limit. */
  remaining: DecimalString | null;
  /** used / limit, percent, one decimal (display only); null without a limit. */
  fillPercent: DecimalString | null;
  /** False while a cargo line of a shipment in the container has no such measure. */
  complete: boolean;
}

/**
 * The container's space (plan 2026-10-27, section 1 and F111-1): computed over every shipment in
 * it, whoever looks. `incomplete` lists only shipments the viewer can see.
 */
export interface ContainerCapacityDto {
  volumeCbm: ContainerCapacityDimensionDto;
  weightKg: ContainerCapacityDimensionDto;
  incomplete: { shipmentId: string; shipmentNumber: string; missing: ContainerMeasure[] }[];
  /** A closed container: its current cargo against its type's current limits, not at closing. */
  asOfNow: boolean;
}

export type ContainerMeasure = 'volumeCbm' | 'weightKg';

/** Whether a shipment would fit in the container, by the same rule the service enforces. */
export interface ContainerFitDto {
  shipmentId: string;
  fits: boolean;
  /** The dimensions the shipment's known cargo would take over the limit. */
  over: ContainerMeasure[];
  /** The dimensions the shipment has a line without a measure for (not checked). */
  unchecked: ContainerMeasure[];
  volumeCbm: DecimalString | null;
  weightKg: DecimalString | null;
  /** Space left after adding it, per dimension (null without a limit). */
  remainingVolumeCbm: DecimalString | null;
  remainingWeightKg: DecimalString | null;
}

export interface ConsolidationShipmentDto {
  shipmentId: string;
  shipmentNumber: string;
  customerName: string;
  status: ShipmentStatus;
  destinationLocationId: string;
  packages: number;
  weightKg: DecimalString | null;
  volumeCbm: DecimalString | null;
  /** The CBM or weight frozen when the container was closed (null while it is open). */
  basisValue: DecimalString | null;
  /** USD cost shared to the shipment so far (null for those who do not see costs). */
  allocatedUsd: DecimalString | null;
}

/** A container cost on an approved supplier bill (rule 7a) and its sharing out (rule 13). */
export interface ConsolidationCostDto {
  billId: string;
  billNumber: string | null;
  supplierName: string;
  lineNo: number;
  chargeTypeCode: string;
  description: string | null;
  currency: CurrencyCode;
  amount: DecimalString;
  /** The rule 13 entry, null until the container is closed. */
  allocationEntryId: string | null;
  allocationEntryNumber: string | null;
}

export interface ConsolidationDto extends ConsolidationSummaryDto {
  sealNumber: string | null;
  carrierName: string | null;
  voyageNumber: string | null;
  masterBlNumber: string | null;
  basis: ConsolidationBasis;
  notes: string | null;
  closedAt: string | null;
  loadedAt: string | null;
  departedAt: string | null;
  arrivedAt: string | null;
  deconsolidatedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdByName: string;
  shipments: ConsolidationShipmentDto[];
  capacity: ContainerCapacityDto;
  /** Whether costs are shown (seesConsolidationCosts); otherwise `costs` is empty. */
  showsCost: boolean;
  costs: ConsolidationCostDto[];
  /** USD left on the clearing account for this container (0 once every cost is shared). */
  clearingBalanceUsd: DecimalString | null;
  /**
   * Whether the container is of one of the user's branches. Another branch sees it while it is
   * open (to book into) or once it holds their shipment: their own shipments only, no costs.
   */
  ownBranch: boolean;
  /** How many times the container was reopened: the `expectedRevision` of the next reopening. */
  reopenRevision: number;
  /** The closes taken back, oldest first (the container's own branch only). */
  reopenings: ConsolidationReopeningDto[];
  actions: {
    canEdit: boolean;
    /** Put an LCL shipment in (another branch: one of its own shipments). */
    canAddShipments: boolean;
    /** Take a shipment out or move it to another open container (the container's branch only). */
    canEditShipments: boolean;
    /** Whether an LCL booking can be made from the container (POST /consolidations/:id/bookings). */
    canAddBooking: boolean;
    moves: ConsolidationMove[];
    canCancel: boolean;
    /** Open a closed container again (B3-5): consolidation:cancel in the container's branch. */
    canReopen: boolean;
  };
}

/** A close taken back (B3-5): when the container had been closed, and why it was reopened. */
export interface ConsolidationReopeningDto {
  revision: number;
  closedAt: string;
  reason: string;
  reopenedAt: string;
  reopenedByName: string;
  /** The shipments that went back to their step before the close. */
  shipmentCount: number;
}

/**
 * `POST /consolidations/:id/reopen` (B3-5). `requestId` is made once per attempt by the screen; a
 * retry with the same id and content returns the container as it is. `expectedRevision` is the
 * `reopenRevision` the screen read.
 */
export interface ConsolidationReopenRequest {
  requestId: string;
  expectedRevision: number;
  expectedStatus: 'CLOSED';
  reason: string;
}

export interface ConsolidationInput {
  branchId: string;
  originLocationId: string;
  destinationLocationId: string;
  containerTypeCode: string;
  containerNumber?: string | null;
  sealNumber?: string | null;
  carrierName?: string | null;
  vesselName?: string | null;
  voyageNumber?: string | null;
  masterBlNumber?: string | null;
  etd?: DateString | null;
  eta?: DateString | null;
  basis?: ConsolidationBasis;
  notes?: string | null;
  shipmentIds: string[];
}

/** PATCH /consolidations/:id: the container's details (branch and route do not change). */
export interface ConsolidationUpdateRequest {
  containerTypeCode?: string;
  containerNumber?: string | null;
  sealNumber?: string | null;
  carrierName?: string | null;
  vesselName?: string | null;
  voyageNumber?: string | null;
  masterBlNumber?: string | null;
  etd?: DateString | null;
  eta?: DateString | null;
  /** Only while the container is open. */
  basis?: ConsolidationBasis;
  notes?: string | null;
}

export interface ConsolidationMoveRequest {
  status: ConsolidationMove;
  /** When it happened; now when omitted. Never in the future. */
  occurredAt?: string;
}

/**
 * POST /consolidations/:id/bookings: an LCL sea booking made from the container's page. It leaves
 * from the container's port of loading; NOLON confirms it, creates its shipment and puts that in
 * the container, all at once. The container must be open.
 */
export type ConsolidationBookingRequest = Omit<
  CreateBookingRequest,
  'mode' | 'loadType' | 'originLocationId'
>;

export interface ConsolidationBookingDto {
  bookingId: string;
  bookingNumber: string;
  shipmentId: string;
  shipmentNumber: string;
}

/** The container a shipment is in, on the shipment page. */
export interface ShipmentConsolidationDto {
  id: string;
  number: string;
  status: ConsolidationStatus;
  containerNumber: string | null;
  sealNumber: string | null;
  containerTypeCode: string;
  /** False when the container is of a branch the user does not work in. */
  canOpen: boolean;
}

/** A container a supplier bill may charge (rule 7a), for the bill form. */
export interface BillableConsolidationDto {
  id: string;
  number: string;
  branchId: string;
  status: ConsolidationStatus;
  containerNumber: string | null;
}
