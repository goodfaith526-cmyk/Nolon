import type {
  BookingService,
  CargoType,
  CustomerKind,
  DateString,
  LoadType,
  LocationKind,
  PriceScope,
  RateUnit,
  ShippingMode,
} from './commercial.js';
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

/** The services a customer-service client may ask for in a booking request, with their names. */
export const CS_CATALOG_SERVICES = [
  { code: 'PICKUP', nameAr: 'استلام من عندك', nameEn: 'Pickup from you' },
  { code: 'LAST_MILE', nameAr: 'التوصيل للمستلم', nameEn: 'Delivery to the receiver' },
] as const;

/** A place a shipment can start or end at (docs/plans/04 section 4), with the names people use. */
export interface CsCatalogPlaceDto {
  id: string;
  code: string;
  kind: LocationKind;
  nameAr: string;
  nameEn: string;
  countryCode: string;
  aliases: string[];
}

export interface CsCatalogCategoryDto {
  code: string;
  nameAr: string;
  nameEn: string;
  unit: RateUnit;
}

/**
 * What a customer-service bot needs to understand a customer (R1): the places with an approved
 * price today, the shipment types and the services. No price, cost or staff name.
 */
export interface CsCatalogDto {
  /** Changes whenever anything in the catalog does. */
  version: string;
  origins: CsCatalogPlaceDto[];
  destinations: CsCatalogPlaceDto[];
  categories: CsCatalogCategoryDto[];
  services: { code: BookingService; nameAr: string; nameEn: string }[];
}

/** A location's other names, as the master-data screen sets them. */
export interface LocationAliasesRequest {
  aliases: string[];
}

/** What a quote prices in its first version: the main freight only; staff price the rest. */
export const CS_QUOTE_INCLUDES = ['MAIN_FREIGHT'] as const;

/** A quote's question (R2, docs/plans/04 section 5): a route, a shipment type, and what it narrows. */
export interface CsQuoteRequest {
  originId: string;
  destinationId: string;
  /** A price category code from the catalog. */
  category: string;
  /** In the category's unit. Without it the answer has no total. */
  quantity?: DecimalString;
  mode?: ShippingMode;
  loadType?: LoadType;
  currency?: CurrencyCode;
  /** Today (UTC) or later; today when left out. */
  onDate?: DateString;
}

/**
 * NOLON's price for a route from its own engine (R2): a guide, not a formal quotation. No cost,
 * margin, staff or internal note. `quoteRef` names it in a booking request (R3) until it expires.
 */
export interface CsQuoteDto {
  price: DecimalString;
  currency: CurrencyCode;
  unit: RateUnit;
  minimumCharge: DecimalString;
  quantity: DecimalString | null;
  /** max(quantity × price, minimum), rounded to the currency's places; null without a quantity. */
  total: DecimalString | null;
  includes: (typeof CS_QUOTE_INCLUDES)[number][];
  mode: ShippingMode;
  loadType: LoadType | null;
  transitDays: number | null;
  validTo: DateString | null;
  scope: { origin: PriceScope; destination: PriceScope };
  source: { rateCardId: string; approvedAt: string; quotedOn: DateString };
  quoteRef: string;
  quoteRefExpiresAt: string;
  /** A note for the customer on the card: none yet, so always null. */
  customerNote: { ar: string; en: string } | null;
  /**
   * Whether a booking request from this origin can be made with this key: a branch that may serve
   * the origin (its routing rules) is one of the key's. False: the client hands over to staff.
   */
  bookable: boolean;
}

/** `422 QUOTE_AMBIGUOUS`: the cards differ on `field`; the client asks the customer, or staff. */
export interface CsQuoteChoices {
  field: 'mode' | 'currency' | 'offer';
  values: string[];
}
