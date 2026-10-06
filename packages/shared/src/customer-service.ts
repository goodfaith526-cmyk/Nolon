import type { CargoType, CustomerKind, DateString, LoadType, ShippingMode } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type {
  PublicLocationDto,
  PublicShipmentStatus,
  PublicTimelineEntryDto,
  ShipmentStatus,
} from './shipments.js';

/**
 * Customer Service API (scope section 17): the customer-safe data a customer-service client (the
 * AI agent later) may read about a customer, with its own API key. It reads only the
 * customer-safe database views (cs_*), so nothing classified Internal or Restricted (costs,
 * margins, credit limits, internal notes, hold and cancel reasons, who did what) can reach it.
 * Records are named by their numbers (NOL-CUS-..., NOL-SHP-..., NOL-INV-...).
 */

/** Requests carry the key as `Authorization: Bearer <key>`. */
export const CS_KEY_PREFIX = 'nolcs_';

export interface CsContactDto {
  name: string;
  position: string | null;
  phone: string;
  email: string | null;
  canInquire: boolean;
  canReceiveCargo: boolean;
  canReceiveDocuments: boolean;
  isPrimary: boolean;
}

export interface CsCustomerDto {
  number: string;
  branchCode: string;
  kind: CustomerKind;
  name: string;
  companyName: string | null;
  phone: string;
  whatsapp: string | null;
  email: string | null;
  preferredLocale: string;
  preferredCurrency: CurrencyCode | null;
  isActive: boolean;
  /** Active authorized persons. */
  contacts: CsContactDto[];
}

export const CS_SHIPMENT_STATES = ['active', 'delivered', 'all'] as const;
export type CsShipmentState = (typeof CS_SHIPMENT_STATES)[number];

export interface CsShipmentSummaryDto {
  number: string;
  /** The shipment's status, machine-readable. */
  status: ShipmentStatus;
  /** The status as public tracking shows it (null for statuses it does not show). */
  publicStatus: PublicShipmentStatus | null;
  mode: ShippingMode;
  loadType: LoadType | null;
  origin: PublicLocationDto;
  destination: PublicLocationDto;
  etd: DateString | null;
  eta: DateString | null;
}

export interface CsShipmentDto extends CsShipmentSummaryDto {
  customerNumber: string;
  cargoType: CargoType;
  currentLocation: PublicLocationDto | null;
  vesselName: string | null;
  voyageNumber: string | null;
  blNumber: string | null;
  packages: number;
  weightKg: DecimalString | null;
  volumeCbm: DecimalString | null;
  /** The public timeline: the actual path, without notes, reasons or who recorded it. */
  timeline: PublicTimelineEntryDto[];
}

export const CS_INVOICE_STATES = ['open', 'all'] as const;
export type CsInvoiceState = (typeof CS_INVOICE_STATES)[number];

/** An approved invoice of the customer, with what is still to pay (invoice currency). */
export interface CsInvoiceDto {
  number: string;
  shipmentNumber: string | null;
  invoiceDate: DateString;
  dueDate: DateString;
  currency: CurrencyCode;
  total: DecimalString;
  paid: DecimalString;
  credited: DecimalString;
  balance: DecimalString;
}

/** An API key of the Customer Service API, as the Administrator sees it (never the key). */
export interface ApiClientDto {
  id: string;
  name: string;
  /** The key's public part, to tell keys apart. */
  keyPrefix: string;
  branchCodes: string[];
  isActive: boolean;
  createdByName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiClientCreateRequest {
  name: string;
  branchIds: string[];
}

/** The key is shown once, at creation; only its hash is kept. */
export interface ApiClientCreatedDto {
  client: ApiClientDto;
  key: string;
}
