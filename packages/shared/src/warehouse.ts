import type { DecimalString } from './currencies.js';
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
  note: string | null;
  occurredAt: string;
  /** The shipment status this receipt applied, or null when it only recorded the goods. */
  statusApplied: ShipmentStatus | null;
  createdByName: string;
  photos: WarehouseMovementPhotoDto[];
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
