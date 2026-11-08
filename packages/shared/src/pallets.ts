import type { ShipmentStatus } from './shipments.js';

/** Plan 15-3: a pallet's states (docs/plans/15-customer-notices-every-stage.md, section 3). */
export const PALLET_STATUSES = ['OPEN', 'CLOSED', 'UNPACKED', 'CANCELLED'] as const;
export type PalletStatus = (typeof PALLET_STATUSES)[number];

/** At most this many shipments on one pallet. */
export const MAX_PALLET_SHIPMENTS = 100;

/** The container or trip carrying a pallet now. */
export interface PalletCarrierDto {
  kind: 'CONTAINER' | 'TRIP';
  id: string;
  number: string;
  status: string;
}

export interface PalletSummaryDto {
  id: string;
  /** JED-P0001: the branch code, P and a serial. */
  number: string;
  branchId: string;
  warehouseId: string;
  warehouseName: { ar: string; en: string };
  status: PalletStatus;
  shipmentCount: number;
  /** Null when no container or trip carries it now. */
  carrier: PalletCarrierDto | null;
  createdAt: string;
}

export interface PalletShipmentDto {
  shipmentId: string;
  number: string;
  status: ShipmentStatus;
  customerName: string;
  addedAt: string;
}

export interface PalletDto extends PalletSummaryDto {
  notes: string | null;
  createdByName: string;
  closedAt: string | null;
  unpackedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  shipments: PalletShipmentDto[];
  /** What the user may do now (the API decides; the screen only shows the buttons). */
  actions: {
    addShipments: boolean;
    close: boolean;
    putInContainer: boolean;
    putOnTrip: boolean;
    takeOut: boolean;
    unpack: boolean;
    cancel: boolean;
  };
}

export interface PalletInput {
  warehouseId: string;
  notes?: string | null;
}
