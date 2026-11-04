import type { PartnerRefDto } from './partners.js';
import type { DecimalString } from './currencies.js';
import type { WarehouseOnHandRowDto } from './operational-reports.js';
import type { ShipmentStatus } from './shipments.js';

/**
 * Warehouse (scope 10): warehouses and storage locations per branch, goods receipts (GRN) and
 * releases (goods release note) against a shipment, and the shipment's movement log.
 */

export const WAREHOUSE_MOVEMENT_KINDS = ['RECEIPT', 'RELEASE'] as const;
export type WarehouseMovementKind = (typeof WAREHOUSE_MOVEMENT_KINDS)[number];

export const GOODS_CONDITIONS = ['GOOD', 'DAMAGED'] as const;
export type GoodsCondition = (typeof GOODS_CONDITIONS)[number];

/** The shipment statuses a goods receipt may move the shipment to (through the state machine). */
export const WAREHOUSE_RECEIPT_STATUSES = [
  'RECEIVED_ORIGIN_WAREHOUSE',
  'RECEIVED_DESTINATION_WAREHOUSE',
] as const satisfies readonly ShipmentStatus[];
export type WarehouseReceiptStatus = (typeof WAREHOUSE_RECEIPT_STATUSES)[number];

/**
 * What a warehouse does in the network (empty: an ordinary warehouse): a collection centre at an
 * origin, the central distribution hub, a delivery centre in a destination city, or a small
 * window where customers hand over goods (origins) or receivers collect them (Sudan).
 */
export const WAREHOUSE_KINDS = [
  'COLLECTION_CENTER',
  'DISTRIBUTION_HUB',
  'DELIVERY_CENTER',
  'DROP_OFF_POINT',
] as const;
export type WarehouseKind = (typeof WAREHOUSE_KINDS)[number];

export interface StorageLocationDto {
  id: string;
  code: string;
  name: string | null;
  isActive: boolean;
}

export interface WarehouseDto {
  id: string;
  branchId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  address: string | null;
  /** The place the warehouse is at (a port, city or yard of the locations master), if set. */
  locationId: string | null;
  kind: WarehouseKind | null;
  /** E.164, the number customers call. */
  phone: string | null;
  /** Map position in WGS 84 degrees, both set or both null. */
  latitude: DecimalString | null;
  longitude: DecimalString | null;
  /** Plan 09 section 11: the English address (`address` is the Arabic one). */
  addressEn: string | null;
  /** Customers bring their shipments here (a drop-off point the bot may name). */
  acceptsDropOff: boolean;
  /** The sales outlet a drop-off window belongs to, if any. */
  partnerId: string | null;
  partner: PartnerRefDto | null;
  /** https only; when null the bot gets a link built from the map position. */
  mapUrl: string | null;
  /** Opening hours as customers read them. */
  hoursAr: string | null;
  hoursEn: string | null;
  isActive: boolean;
  storageLocations: StorageLocationDto[];
}

export interface WarehouseInput {
  branchId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  address?: string | null;
  /** A goods receipt that moves the shipment records it at this place (functional review D9). */
  locationId?: string | null;
}

/** PATCH /warehouses/:id. Branch and code do not change. */
export interface WarehouseUpdateRequest {
  nameEn?: string;
  nameAr?: string;
  address?: string | null;
  locationId?: string | null;
  isActive?: boolean;
  /** Plan 09 section 11: the drop-off details (latitude and longitude both set or both null). */
  addressEn?: string | null;
  acceptsDropOff?: boolean;
  partnerId?: string | null;
  mapUrl?: string | null;
  hoursAr?: string | null;
  hoursEn?: string | null;
  phone?: string | null;
  latitude?: DecimalString | null;
  longitude?: DecimalString | null;
}

export interface StorageLocationInput {
  code: string;
  name?: string | null;
}

export interface StorageLocationUpdateRequest {
  name?: string | null;
  isActive?: boolean;
}

export interface WarehouseMovementPhotoDto {
  documentId: string;
  fileName: string;
}

export interface WarehouseMovementDto {
  id: string;
  /** NOL-GRN-2026-000001 or NOL-GRL-2026-000001. */
  number: string;
  kind: WarehouseMovementKind;
  warehouseId: string;
  warehouseCode: string;
  storageLocationId: string | null;
  storageLocationCode: string | null;
  packages: number;
  weightKg: DecimalString | null;
  condition: GoodsCondition | null;
  partyName: string | null;
  /** Plan 09e: the ID the person who handed the goods over showed (receipts only), as typed. */
  partyIdType: string | null;
  partyIdNumber: string | null;
  note: string | null;
  occurredAt: string;
  /** The shipment status this receipt applied, or null when it only recorded the goods. */
  statusApplied: ShipmentStatus | null;
  createdByName: string;
  photos: WarehouseMovementPhotoDto[];
  /** Set once the movement is cancelled (B3-1): it no longer counts in any balance. */
  cancellation: WarehouseMovementCancellationDto | null;
}

export interface WarehouseMovementCancellationDto {
  reason: string;
  cancelledAt: string;
  cancelledByName: string;
}

/** POST /shipments/:shipmentId/warehouse/movements/:movementId/cancel. */
export interface WarehouseMovementCancelRequest {
  /** 3 to 500 characters. */
  reason: string;
}

/** What one warehouse holds for the shipment. */
export interface WarehouseBalanceDto {
  warehouseId: string;
  warehouseCode: string;
  nameEn: string;
  nameAr: string;
  receivedPackages: number;
  releasedPackages: number;
  onHandPackages: number;
  receivedWeightKg: DecimalString;
  releasedWeightKg: DecimalString;
  /**
   * The weight still held here when it is known (every receipt and release here was weighed):
   * suggested for a release of everything held here, never for a part of it (functional review
   * D5). Null when unknown or when nothing is held.
   */
  remainingWeightKg: DecimalString | null;
}

export interface ShipmentWarehouseActionsDto {
  canReceive: boolean;
  canRelease: boolean;
  canAddPhotos: boolean;
  /**
   * Whether this user may cancel the shipment's receipts and releases (warehouse:cancel in the
   * shipment's branch, shipment not closed). The API still checks each cancel's balances.
   */
  canCancelMovements: boolean;
  /** Statuses a receipt may move the shipment to now (state machine and permissions). */
  receiptStatuses: WarehouseReceiptStatus[];
  /** Preselected on the receipt form: the only allowed status, when there is exactly one. */
  defaultReceiptStatus: WarehouseReceiptStatus | null;
}

/** GET /shipments/:id/warehouse. */
export interface ShipmentWarehouseDto {
  /** Packages on the shipment's cargo lines (what a full receipt expects). */
  expectedPackages: number;
  /** Packages held now in all warehouses (received minus released, per warehouse, added up). */
  heldPackages: number;
  /** Packages still to receive: the expected ones not held anywhere now (never below zero). */
  remainingPackages: number;
  balances: WarehouseBalanceDto[];
  /** Movement log, oldest first. */
  movements: WarehouseMovementDto[];
  actions: ShipmentWarehouseActionsDto;
}

export interface GoodsReceiptRequest {
  warehouseId: string;
  storageLocationId?: string | null;
  packages: number;
  weightKg?: DecimalString | null;
  condition: GoodsCondition;
  partyName?: string | null;
  /** Plan 09e: the ID type (free text, e.g. passport) and number the person handing over showed. */
  partyIdType?: string | null;
  partyIdNumber?: string | null;
  note?: string | null;
  /** Defaults to now; may be earlier, never in the future. */
  occurredAt?: string;
  /** Move the shipment to this status too, when the state machine allows it now. */
  shipmentStatus?: WarehouseReceiptStatus | null;
  /**
   * Confirms a receipt that makes the warehouses hold more packages than the cargo lines have
   * (a miscounted booking). Without it such a receipt is refused; with it a note is required.
   */
  extraPackagesConfirmed?: boolean;
}

export interface GoodsReleaseRequest {
  warehouseId: string;
  packages: number;
  weightKg?: DecimalString | null;
  partyName?: string | null;
  note?: string | null;
  occurredAt?: string;
}

/**
 * A shipment whose status says its goods are in a warehouse, with no goods receipt behind it: the
 * status was changed without one (or the receipt was cancelled). Recording the receipt puts it in
 * the warehouse's stock.
 */
export interface AwaitingReceiptDto {
  shipmentId: string;
  shipmentNumber: string;
  branchCode: string;
  customerName: string;
  status: WarehouseReceiptStatus;
  /** When the shipment entered that status. */
  statusAt: string;
}

/**
 * GET /warehouses/stock: the shipments each warehouse holds now (live receipts less live
 * releases, the stock's one source), and the shipments waiting for a goods receipt.
 */
export interface WarehouseStockDto {
  /** Today, in the first of the user's branches' time zone (each row uses its own branch's). */
  asOf: string;
  rows: WarehouseOnHandRowDto[];
  truncated: boolean;
  awaitingReceipt: AwaitingReceiptDto[];
  /** More shipments await a receipt than the list shows. */
  awaitingTruncated: boolean;
}
