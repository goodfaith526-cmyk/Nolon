import type { DateString } from './commercial.js';
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
  /** NOL-CON-2026-000001 */
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
  /** Whether costs are shown (seesConsolidationCosts); otherwise `costs` is empty. */
  showsCost: boolean;
  costs: ConsolidationCostDto[];
  /** USD left on the clearing account for this container (0 once every cost is shared). */
  clearingBalanceUsd: DecimalString | null;
  actions: {
    canEdit: boolean;
    canEditShipments: boolean;
    moves: ConsolidationMove[];
    canCancel: boolean;
  };
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

/** The container a shipment is in, on the shipment page. */
export interface ShipmentConsolidationDto {
  id: string;
  number: string;
  status: ConsolidationStatus;
  containerNumber: string | null;
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
