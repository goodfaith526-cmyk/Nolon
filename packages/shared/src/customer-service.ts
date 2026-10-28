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
 * Records are named by their numbers (CS00001, BK00001 or DXB-KRT-0001, NOL-INV-...).
 */

/** Requests carry the key as `Authorization: Bearer <key>`. */
export const CS_KEY_PREFIX = 'nolcs_';

/**
 * What a key may do (docs/plans/04 section 2). Each /cs route needs one; a key holds only the
 * scopes the Administrator gave it. `cs:customers:read` is the original reads of every customer of
 * the key's branches; a customer-facing bot's key should not hold it.
 */
export const CS_SCOPES = [
  'cs:customers:read',
  'cs:customer_tokens:issue',
  'cs:catalog:read',
  'cs:quote:read',
  'cs:booking_requests:create',
  'cs:tracking:lookup',
] as const;
export type CsScope = (typeof CS_SCOPES)[number];

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
  /** In CS_SCOPES order. */
  scopes: CsScope[];
  isActive: boolean;
  createdByName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiClientCreateRequest {
  name: string;
  branchIds: string[];
  scopes: CsScope[];
}

/** Replaces a key's scopes. */
export interface ApiClientScopesRequest {
  scopes: CsScope[];
}

/** The key is shown once, at creation; only its hash is kept. */
export interface ApiClientCreatedDto {
  client: ApiClientDto;
  key: string;
}

/** A token for one customer (docs/plans/04 section 3, N1): `Authorization: Bearer nolct_...`. */
export const CS_TOKEN_PREFIX = 'nolct_';

/** At most this long; every use rechecks the key, the customer and the match anyway. */
export const CS_TOKEN_TTL_MS = 10 * 60 * 1000;

export type CsAccessLevel = 'L1' | 'L2';

export interface CsCustomerTokenRequest {
  /** The sender's number as the channel verified it, +E.164. Never a number the customer typed. */
  phone: string;
  /** The account the sender chose from a `choose` answer. */
  customerNumber?: string;
  /** A proof of an email code (N3). Until N3 exists, no proof is valid and the level is L1. */
  verificationId?: string;
}

/** What the sender may choose between: no phone, email or balance. */
export interface CsCustomerChoiceDto {
  number: string;
  label: string;
}

export type CsCustomerTokenAnswer =
  | { kind: 'none' }
  | { kind: 'choose'; customers: CsCustomerChoiceDto[] }
  | {
      kind: 'token';
      token: string;
      expiresAt: string;
      customer: CsCustomerChoiceDto;
      /** Stable for the reason of the match (the customer's phone, WhatsApp, or one contact). */
      grantId: string;
      /** Changes whenever the matched customer or contact record changes. */
      grantVersion: number;
      level: CsAccessLevel;
    };
