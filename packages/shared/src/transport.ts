import type { DateString } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type { ShipmentStatus } from './shipments.js';

/**
 * Inland transport (scope 12): fleet master data (owned vehicles, drivers, external carriers),
 * trips carrying one or more shipments, trip costs (annex C rules 10 and 11) and proof of
 * delivery (POD). Amounts and weights are decimal strings.
 */

// ---------------------------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------------------------

export interface VehicleDto {
  id: string;
  branchId: string;
  plateNumber: string;
  /** Free text the client extends (flatbed, 40ft trailer, box truck...). */
  vehicleType: string;
  capacityKg: DecimalString | null;
  isActive: boolean;
}

export interface VehicleInput {
  branchId: string;
  plateNumber: string;
  vehicleType: string;
  capacityKg?: DecimalString | null;
}

/** PATCH /transport/vehicles/:id. Branch and plate do not change. */
export interface VehicleUpdateRequest {
  vehicleType?: string;
  capacityKg?: DecimalString | null;
  isActive?: boolean;
}

export interface DriverDto {
  id: string;
  branchId: string;
  name: string;
  phone: string | null;
  licenseNumber: string | null;
  /** The user account (with the DRIVER role) that sees this driver's trips. */
  userId: string | null;
  userName: string | null;
  isActive: boolean;
}

export interface DriverInput {
  branchId: string;
  name: string;
  phone?: string | null;
  licenseNumber?: string | null;
  userId?: string | null;
}

export interface DriverUpdateRequest {
  name?: string;
  phone?: string | null;
  licenseNumber?: string | null;
  userId?: string | null;
  isActive?: boolean;
}

/** A user who can be linked to a driver: active, with the DRIVER role. */
export interface DriverUserOptionDto {
  id: string;
  fullName: string;
  email: string;
}

export interface CarrierDto {
  id: string;
  name: string;
  phone: string | null;
  /** The supplier whose bills settle this carrier's trips (annex C rule 11a). */
  supplierId: string | null;
  supplierName: string | null;
  isActive: boolean;
}

export interface CarrierInput {
  name: string;
  phone?: string | null;
}

/** The supplier link is set from the supplier (PUT /suppliers/:id/carriers/:carrierId). */
export interface CarrierUpdateRequest {
  name?: string;
  phone?: string | null;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------------------------

export const TRIP_KINDS = ['OWN', 'EXTERNAL'] as const;
export type TripKind = (typeof TRIP_KINDS)[number];

/**
 * PLANNED → DEPARTED → ARRIVED → COMPLETED; CANCELLED from PLANNED only. Departing and arriving
 * move every shipment on the trip to ROAD_DEPARTED / ROAD_ARRIVED; completing an external trip
 * accrues its agreed cost (annex C rule 11).
 */
export const TRIP_STATUSES = ['PLANNED', 'DEPARTED', 'ARRIVED', 'COMPLETED', 'CANCELLED'] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/** The moves POST /trips/:id/status accepts. */
export const TRIP_MOVES = ['DEPARTED', 'ARRIVED', 'COMPLETED'] as const;
export type TripMove = (typeof TRIP_MOVES)[number];

/** How a trip cost is shared between its shipments (annex C: CBM by default, else weight). */
export const COST_SPLIT_BASES = ['CBM', 'WEIGHT', 'EQUAL'] as const;
export type CostSplitBasis = (typeof COST_SPLIT_BASES)[number];

export interface TripSummaryDto {
  id: string;
  /** NOL-TRP-2026-000001 */
  number: string;
  branchId: string;
  kind: TripKind;
  status: TripStatus;
  originLocationId: string;
  destinationLocationId: string;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  actualDeparture: string | null;
  actualArrival: string | null;
  /** Plate (own) or the carrier's vehicle as written (external). */
  vehicleLabel: string | null;
  /** Driver's name (own) or as written (external). */
  driverLabel: string | null;
  carrierName: string | null;
  shipmentCount: number;
}

export interface TripShipmentDto {
  shipmentId: string;
  shipmentNumber: string;
  customerName: string;
  status: ShipmentStatus;
  destinationLocationId: string;
  packages: number;
  weightKg: DecimalString | null;
  volumeCbm: DecimalString | null;
  /** The driver or staff may record a POD for this shipment now. */
  canRecordPod: boolean;
}

export interface TripCostShareDto {
  shipmentId: string;
  shipmentNumber: string;
  amount: DecimalString;
}

export interface TripExpenseDto {
  id: string;
  /** NOL-TEX-2026-000001 */
  number: string;
  expenseDate: DateString;
  description: string;
  amount: DecimalString;
  currency: CurrencyCode;
  fxRate: DecimalString;
  cashAccountId: string;
  cashAccountCode: string;
  journalEntryId: string;
  journalNumber: string;
  status: 'POSTED' | 'CANCELLED';
  cancelReason: string | null;
  createdByName: string;
  shares: TripCostShareDto[];
}

/** A cash or bank account an expense of this trip may be paid from. */
export interface TripCashAccountDto {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  currency: CurrencyCode;
}

export interface TripActionsDto {
  /** Moves allowed now (the API checks every shipment again when one is chosen). */
  moves: TripMove[];
  canCancel: boolean;
  canEditShipments: boolean;
  canAddExpense: boolean;
  canCancelExpense: boolean;
}

export interface TripDto extends TripSummaryDto {
  vehicleId: string | null;
  driverId: string | null;
  carrierId: string | null;
  /** Null for users who do not see transport costs (showsCost false). */
  agreedCost: DecimalString | null;
  currency: CurrencyCode | null;
  externalVehicle: string | null;
  externalDriver: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  notes: string | null;
  createdByName: string;
  /** Rule 11: the accrual posted when the external trip was completed (null when costs are hidden). */
  accrualJournalEntryId: string | null;
  accrualJournalNumber: string | null;
  /** Empty for users who do not see transport costs. */
  accrualShares: TripCostShareDto[];
  /**
   * Whether the user sees transport costs (seesTransportCosts, annex A "costs (Restricted)"):
   * otherwise the agreed cost and the accrual entry are null, and no cost shares or expenses are
   * listed.
   */
  showsCost: boolean;
  shipments: TripShipmentDto[];
  /** Empty for users who do not see transport costs. */
  expenses: TripExpenseDto[];
  /** Filled when actions.canAddExpense: the accounts an expense may be paid from. */
  cashAccounts: TripCashAccountDto[];
  actions: TripActionsDto;
}

export interface TripInput {
  branchId: string;
  kind: TripKind;
  originLocationId: string;
  destinationLocationId: string;
  plannedDeparture?: string | null;
  plannedArrival?: string | null;
  vehicleId?: string | null;
  driverId?: string | null;
  carrierId?: string | null;
  agreedCost?: DecimalString | null;
  currency?: CurrencyCode | null;
  externalVehicle?: string | null;
  externalDriver?: string | null;
  notes?: string | null;
  shipmentIds: string[];
}

export interface TripMoveRequest {
  status: TripMove;
  /** When it happened; defaults to now. Not in the future. */
  occurredAt?: string;
}

export interface TripExpenseRequest {
  /**
   * Generated by the client once per expense form (a UUID). Resending the same id, after a
   * timeout or a double click, returns the first expense instead of posting a second one.
   */
  requestId: string;
  expenseDate: DateString;
  description: string;
  amount: DecimalString;
  currency: CurrencyCode;
  /** Units per 1 USD; defaults to the rate table's rate for the date. */
  fxRate?: string | null;
  cashAccountId: string;
}

/** A trip on the shipment page: one road leg. */
export interface ShipmentTripDto {
  id: string;
  number: string;
  kind: TripKind;
  status: TripStatus;
  originLocationId: string;
  destinationLocationId: string;
  actualDeparture: string | null;
  actualArrival: string | null;
  vehicleLabel: string | null;
  driverLabel: string | null;
  /** False for a trip of another branch (the other end of the shipment): listed, not opened. */
  canOpen: boolean;
}

// ---------------------------------------------------------------------------------------------
// Proof of delivery
// ---------------------------------------------------------------------------------------------

/** The shipment statuses recording a POD may move the shipment to (through the state machine). */
export const POD_STATUSES = [
  'PARTIALLY_DELIVERED',
  'DELIVERED',
] as const satisfies readonly ShipmentStatus[];
export type PodStatus = (typeof POD_STATUSES)[number];

export interface PodDto {
  id: string;
  /** NOL-POD-2026-000001 */
  number: string;
  shipmentId: string;
  tripId: string | null;
  tripNumber: string | null;
  recipientName: string;
  /** Consignee, agent, employee... as written. */
  recipientCapacity: string;
  deliveredAt: string;
  packages: number | null;
  note: string | null;
  statusApplied: PodStatus | null;
  signatureDocumentId: string;
  photos: { documentId: string; fileName: string }[];
  createdByName: string;
}

/** GET /shipments/:id/pods. */
export interface ShipmentPodsDto {
  pods: PodDto[];
  actions: {
    canRecord: boolean;
    /** Statuses a POD may move the shipment to now. */
    statuses: PodStatus[];
    defaultStatus: PodStatus | null;
    /** Trips of this shipment a POD may refer to (the driver's own, for a driver). */
    trips: { id: string; number: string }[];
  };
}

/**
 * POST /shipments/:id/pods, multipart: these fields, a `signature` PNG and up to MAX_POD_PHOTOS
 * `photos`.
 */
export interface PodFields {
  recipientName: string;
  recipientCapacity: string;
  deliveredAt?: string;
  packages?: number | null;
  note?: string | null;
  tripId?: string | null;
  shipmentStatus?: PodStatus | null;
}

export const MAX_POD_PHOTOS = 5;
