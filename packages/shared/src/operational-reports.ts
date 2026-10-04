import type { BookingStatus, QuotationStatus, ShippingMode } from './commercial.js';
import type { DecimalString } from './currencies.js';
import type { CustomsStatus } from './customs.js';
import type { ReportBranchDto, ReportLocationDto } from './reports.js';
import type { ShipmentStatus } from './shipments.js';
import type { TripKind, TripStatus } from './transport.js';
import type { GoodsCondition, WarehouseMovementKind } from './warehouse.js';

/**
 * Operational reports (annex D section 3), in the user's branches (the requested one, checked, or
 * all of theirs). Each needs operational_reports:view, except the audit log (audit_log:view).
 * Dates are YYYY-MM-DD in the branch's time zone; counts are integers; weights, volumes and
 * amounts are decimal strings, amounts in USD. Each report is also exported to Excel by the same
 * path with `/export`.
 *
 * Not built: report 5 (consolidated containers and their contents), as consolidation does not
 * exist yet.
 */
export const OPERATIONAL_REPORTS = [
  'shipments',
  'late-shipments',
  'sales-conversion',
  'customer-activity',
  'warehouse-on-hand',
  'warehouse-movements',
  'customs-files',
  'trips',
  'audit-log',
] as const;
export type OperationalReport = (typeof OPERATIONAL_REPORTS)[number];

/** Report rows are capped; `truncated` says more matched than came back. */
export const OPERATIONAL_REPORT_ROW_LIMIT = 2000;

export interface ReportCustomerRefDto {
  customerId: string;
  customerName: string;
}

// ---- 1. Shipments by status, branch, route and mode ------------------------------------------

export interface ShipmentReportRowDto extends ReportCustomerRefDto {
  shipmentId: string;
  number: string;
  branchCode: string;
  origin: ReportLocationDto;
  destination: ReportLocationDto;
  mode: ShippingMode;
  status: ShipmentStatus;
  /** The day it was created, in its branch. */
  createdOn: string;
  etd: string | null;
  eta: string | null;
}

export interface ShipmentsReportDto {
  from: string;
  to: string;
  branchId: string | null;
  customerId: string | null;
  mode: ShippingMode | null;
  status: ShipmentStatus | null;
  total: number;
  byStatus: { status: ShipmentStatus; count: number }[];
  byBranch: (ReportBranchDto & { count: number })[];
  byRoute: { origin: ReportLocationDto; destination: ReportLocationDto; count: number }[];
  byMode: { mode: ShippingMode; count: number }[];
  shipments: ShipmentReportRowDto[];
  truncated: boolean;
}

// ---- 2. Shipments late against ETA -------------------------------------------------------------

export interface LateShipmentRowDto extends ReportCustomerRefDto {
  shipmentId: string;
  number: string;
  branchCode: string;
  origin: ReportLocationDto;
  destination: ReportLocationDto;
  mode: ShippingMode;
  status: ShipmentStatus;
  eta: string;
  /** The day it was delivered, in its branch; null while not delivered. */
  deliveredOn: string | null;
  /** Days after the ETA it was delivered, or (still open) that have passed by today. */
  daysLate: number;
}

/**
 * Shipments whose ETA falls in the period and that were delivered after it, or are still not
 * delivered with the ETA before today. Cancelled shipments are left out.
 */
export interface LateShipmentsDto {
  from: string;
  to: string;
  branchId: string | null;
  customerId: string | null;
  /** Shipments with an ETA in the period (not cancelled). */
  withEta: number;
  late: number;
  openLate: number;
  deliveredLate: number;
  /** Mean of daysLate, to 1 place; null when none is late. */
  averageDaysLate: DecimalString | null;
  shipments: LateShipmentRowDto[];
  truncated: boolean;
}

// ---- 3. Bookings and quotations with the conversion rate ---------------------------------------

export interface SalesConversionFiguresDto {
  /** Quotations sent to the customer in the period (by the day they were sent). */
  quotationsSent: number;
  /** Of those, by their status now. */
  quotations: Record<Exclude<QuotationStatus, 'DRAFT'>, number>;
  /** Of those, the ones that have a booking that is not cancelled. */
  quotationsBooked: number;
  /** Bookings created in the period, by their status now. */
  bookingsCreated: number;
  bookings: Record<BookingStatus, number>;
  /** Of those, the ones made from a quotation. */
  bookingsFromQuotation: number;
  /** Approved / sent x 100, to 2 places; null without quotations. */
  approvalRate: DecimalString | null;
  /** Booked / sent x 100, to 2 places; null without quotations. */
  conversionRate: DecimalString | null;
  /** (Confirmed + completed) / created x 100, to 2 places; null without bookings. */
  confirmationRate: DecimalString | null;
}

export interface SalesConversionDto {
  from: string;
  to: string;
  branchId: string | null;
  customerId: string | null;
  branches: (ReportBranchDto & SalesConversionFiguresDto)[];
  totals: SalesConversionFiguresDto;
}

// ---- 4. Customer activity ----------------------------------------------------------------------

export interface CustomerActivityRowDto extends ReportCustomerRefDto {
  /** Shipments created in the period (not cancelled). */
  shipments: number;
  /** Their cargo lines' volume and weight. */
  volumeCbm: DecimalString;
  weightKg: DecimalString;
  /** Approved invoices dated in the period, with their posted entries. */
  invoices: number;
  revenueUsd: DecimalString;
}

export interface CustomerActivityDto {
  from: string;
  to: string;
  branchId: string | null;
  customerId: string | null;
  customers: CustomerActivityRowDto[];
  totals: Omit<CustomerActivityRowDto, 'customerId' | 'customerName'>;
}

// ---- 6. Warehouse: goods on hand now and days held ---------------------------------------------

export interface WarehouseOnHandRowDto extends ReportCustomerRefDto {
  shipmentId: string;
  shipmentNumber: string;
  branchCode: string;
  warehouseId: string;
  warehouseCode: string;
  packages: number;
  /** Received weight less released weight. */
  weightKg: DecimalString;
  /** The day the goods now held started to be held (in the shipment's branch). */
  heldSince: string;
  daysHeld: number;
}

export interface WarehouseOnHandDto {
  /** Today, in the first listed branch's time zone (each row uses its own branch's). */
  asOf: string;
  branchId: string | null;
  warehouseId: string | null;
  rows: WarehouseOnHandRowDto[];
  totals: { shipments: number; packages: number; weightKg: DecimalString };
  truncated: boolean;
}

// ---- 7. Warehouse: receipt and release movements -----------------------------------------------

export interface WarehouseMovementRowDto extends ReportCustomerRefDto {
  movementId: string;
  number: string;
  kind: WarehouseMovementKind;
  /** When it happened, ISO 8601. */
  occurredAt: string;
  shipmentId: string;
  shipmentNumber: string;
  branchCode: string;
  warehouseCode: string;
  packages: number;
  weightKg: DecimalString | null;
  condition: GoodsCondition | null;
  partyName: string | null;
  createdByName: string;
}

export interface MovementTotalsDto {
  movements: number;
  packages: number;
  weightKg: DecimalString;
}

export interface WarehouseMovementsDto {
  from: string;
  to: string;
  branchId: string | null;
  warehouseId: string | null;
  kind: WarehouseMovementKind | null;
  receipts: MovementTotalsDto;
  releases: MovementTotalsDto;
  movements: WarehouseMovementRowDto[];
  truncated: boolean;
}

// ---- 8. Customs files by status, with clearance time -------------------------------------------

export interface CustomsFileRowDto extends ReportCustomerRefDto {
  clearanceId: string;
  shipmentId: string;
  shipmentNumber: string;
  branchCode: string;
  status: CustomsStatus;
  declarationNumber: string | null;
  brokerName: string | null;
  /** The file's day in the period: its submission, or its creation while not submitted. */
  openedOn: string;
  submittedOn: string | null;
  clearedOn: string | null;
  /** Cleared files: days from submission to clearance. */
  clearanceDays: number | null;
  /** Files not cleared: days since submission (or since the file was opened) until today. */
  daysOpen: number | null;
}

export interface CustomsFilesDto {
  from: string;
  to: string;
  branchId: string | null;
  status: CustomsStatus | null;
  byStatus: { status: CustomsStatus; count: number }[];
  total: number;
  /** Mean clearance days of the cleared files, to 1 place; null when none is cleared. */
  averageClearanceDays: DecimalString | null;
  files: CustomsFileRowDto[];
  truncated: boolean;
}

// ---- 9. Trips by vehicle, driver and carrier, with their cost ----------------------------------

export interface TripReportRowDto {
  tripId: string;
  number: string;
  branchCode: string;
  kind: TripKind;
  status: TripStatus;
  /** Departure (actual, else planned, else creation) day in the trip's branch. */
  tripDate: string;
  origin: ReportLocationDto;
  destination: ReportLocationDto;
  vehicleId: string | null;
  /** Own vehicle plate, or the hired truck as written. */
  vehicle: string | null;
  driverId: string | null;
  /** Own driver's name, or the hired driver as written. */
  driver: string | null;
  carrierId: string | null;
  carrierName: string | null;
  shipments: number;
  /** Posted trip expenses (less cancellations) and the posted accrual (less its reversal). */
  costUsd: DecimalString;
}

export interface TripGroupDto {
  id: string;
  name: string;
  trips: number;
  costUsd: DecimalString;
}

export interface TripsReportDto {
  from: string;
  to: string;
  branchId: string | null;
  kind: TripKind | null;
  vehicleId: string | null;
  driverId: string | null;
  carrierId: string | null;
  trips: TripReportRowDto[];
  byVehicle: TripGroupDto[];
  byDriver: TripGroupDto[];
  byCarrier: TripGroupDto[];
  totals: { trips: number; costUsd: DecimalString };
  truncated: boolean;
}

// ---- 10. Audit log -----------------------------------------------------------------------------

/**
 * There is no general audit table: the log is read from the records that already say who did
 * what and when (shipment events, warehouse movements, customs fees and files, journal entries,
 * invoices, receipts, trips, trip expenses, proofs of delivery and documents). Edits that leave no
 * such record (a customer's address, a draft's lines, a user's roles) are not in it.
 */
export const AUDIT_ENTITIES = [
  'SHIPMENT',
  'WAREHOUSE_MOVEMENT',
  'CUSTOMS',
  'JOURNAL_ENTRY',
  'INVOICE',
  'RECEIPT',
  'TRIP',
  'TRIP_EXPENSE',
  'POD',
  'DOCUMENT',
] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export const AUDIT_ACTIONS = [
  'CREATED',
  'UPDATED',
  'STATUS',
  'HOLD',
  'RESUME',
  'REVERT',
  'CANCELLED',
  'RECEIVED',
  'RELEASED',
  'FEE_ADDED',
  'POSTED',
  'APPROVED',
  'UPLOADED',
  'DELETED',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditLogEntryDto {
  /** When it was recorded, ISO 8601. */
  at: string;
  branchCode: string;
  userId: string | null;
  userName: string | null;
  entity: AuditEntity;
  action: AuditAction;
  /** The record's number (or file name). */
  reference: string;
  /**
   * The status reached, as its code: a shipment status (SHIPMENT), customs status (CUSTOMS) or
   * trip status (TRIP); null otherwise.
   */
  status: string | null;
  /** The reason or note, as recorded. */
  detail: string | null;
}

export interface AuditLogDto {
  from: string;
  to: string;
  branchId: string | null;
  userId: string | null;
  entity: AuditEntity | null;
  entries: AuditLogEntryDto[];
  /** The users in `entries`, for the user filter. */
  users: { id: string; name: string }[];
  truncated: boolean;
}
