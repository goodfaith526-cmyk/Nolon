import type {
  BookingService,
  CargoType,
  CreateBookingRequest,
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
  'cs:customer_profiles:write',
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
  phone: string | null;
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
  /** The services the key's bot offers (its catalog lists and its requests may ask for), in CS_REQUEST_SERVICES order. */
  services: CsRequestService[];
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
  /** Left out: both (every key before services could be turned off offered both). */
  services?: CsRequestService[];
}

export interface ApiClientServicesRequest {
  services: CsRequestService[];
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

/** The services a booking request may ask for (the catalog's). */
export const CS_REQUEST_SERVICES = ['PICKUP', 'LAST_MILE'] as const;
export type CsRequestService = (typeof CS_REQUEST_SERVICES)[number];

export const CS_SENDER_CHANNELS = ['whatsapp', 'telegram'] as const;
export type CsSenderChannel = (typeof CS_SENDER_CHANNELS)[number];

export const CS_HANDOVERS = ['PICKUP', 'BRANCH_DROP'] as const;

/** At most this many new booking requests per owner per day (UTC); a retry does not count. */
export const CS_DAILY_REQUESTS = 5;

/** A request nobody decided in this long is expired. */
export const CS_REQUEST_TTL_DAYS = 14;

/**
 * A booking request (R3, docs/plans/04 section 7.1). With a customer token the owner is the
 * token's customer, and `sender` is refused; without one `sender` is required: a channel identity
 * the key vouches its channel verified, never linked to an account by itself.
 */
export interface CsBookingRequestCreate {
  profileId?: string;
  conversationId?: string;
  sender?: { channel: CsSenderChannel; id: string };
  /** A number shared for contact only (Telegram's «share my number»). */
  contactPhone?: string;
  originId: string;
  destinationId: string;
  category: string;
  quantity: DecimalString;
  services: (typeof CS_REQUEST_SERVICES)[number][];
  senderName: string;
  consigneeName: string;
  consigneePhone: string;
  handover: (typeof CS_HANDOVERS)[number];
  requestedDate?: DateString;
  /** A quote (R2) of the same key whose inputs match this request. */
  quoteRef?: string;
  language: 'ar' | 'en';
  idempotencyKey: string;
}

/**
 * A booking request in the bot's own words (erp-agents #247, the agent project's
 * nolon-request-ar.md R3): places and type by the names the customer saw, matched by NOLON; what
 * does not match stays for staff. Key only, never with a customer token.
 */
export interface CsBookingRequestByNames {
  profileId?: string;
  conversationId?: string;
  idempotencyKey: string;
  channel: CsSenderChannel;
  origin: CsName;
  destination: CsName;
  kind: CsName;
  quantity: number | DecimalString;
  senderName: string;
  /** Digits: on WhatsApp the number WhatsApp verified; on Telegram the one the customer wrote. */
  senderPhone?: string;
  receiverName: string;
  receiverPhone: string;
  handover: (typeof CS_BOT_HANDOVERS)[number];
  /** The price the bot showed from its own material: kept for staff to check, never a price. */
  quotedPrice?: { amount: DecimalString; currency: string } | null;
}

export interface CsName {
  ar: string;
  en: string;
}

export const CS_BOT_HANDOVERS = ['pickup', 'dropoff'] as const;

/** A request by names reads `pending` while it awaits routing: its bot knows no such state. */
export type CsBookingRequestState =
  'awaiting_routing' | 'pending' | 'approved' | 'rejected' | 'expired';

export interface CsBookingRequestCreated {
  requestId: string;
  status: CsBookingRequestState;
  reference: string;
}

/** What the owner reads back (section 7.2). Decisions fill the last three (R3, staff review). */
export interface CsBookingRequestDto {
  requestId: string;
  reference: string;
  status: CsBookingRequestState;
  createdAt: string;
  expiresAt: string;
  bookingNumber: string | null;
  customerReason: { ar: string; en: string } | null;
  /**
   * Plan 04 section 4.1: the approved instructions of the request's branch and payment currency,
   * once approved; null when there are none (the bot says staff will send how to pay).
   */
  paymentInstructions: CsPaymentInstructionsDto | null;
}

/** How the customer pays, as the bot shows it word for word with its version (plan 04, 4.1). */
export interface CsPaymentInstructionsDto {
  id: string;
  version: number;
  branchCode: string;
  currency: string;
  textAr: string;
  textEn: string;
}

export const PAYMENT_INSTRUCTION_STATUSES = ['DRAFT', 'APPROVED', 'RETIRED'] as const;
export type PaymentInstructionStatus = (typeof PAYMENT_INSTRUCTION_STATUSES)[number];

/**
 * Payment instructions of a branch and currency (plan 04 section 4.1), for staff. A draft is
 * edited; another person approves it, which retires the approved one of its branch and currency;
 * an approved one is never edited, only retired.
 */
export interface PaymentInstructionDto {
  id: string;
  branchId: string;
  branchCode: string;
  currency: string;
  textAr: string;
  textEn: string;
  status: PaymentInstructionStatus;
  version: number;
  createdById: string;
  createdByName: string;
  /** Who wrote the current text (its maker, or the last editor); never its approver. */
  editedByName: string;
  createdAt: string;
  approvedByName: string | null;
  approvedAt: string | null;
  retiredAt: string | null;
  actions: { canEdit: boolean; canApprove: boolean; canRetire: boolean };
}

export interface PaymentInstructionInput {
  branchId: string;
  currency: CurrencyCode;
  textAr: string;
  textEn: string;
}

export interface PaymentInstructionUpdate {
  version: number;
  textAr: string;
  textEn: string;
}

/** Approve or retire: the version the person saw. */
export interface PaymentInstructionDecision {
  version: number;
}

/** Why staff reject a bot's booking request, as the customer reads it (plan 04a section 4). */
export interface CsRejectReasonDto {
  code: string;
  textAr: string;
  textEn: string;
  isActive: boolean;
}

export interface CsRejectReasonInput {
  textAr: string;
  textEn: string;
  isActive: boolean;
}

/** A staff list's filter: the requests still undecided (default), or one state. */
export const CS_REVIEW_FILTERS = [
  'open',
  'awaiting_routing',
  'pending',
  'approved',
  'rejected',
  'expired',
] as const;
export type CsReviewFilter = (typeof CS_REVIEW_FILTERS)[number];

/** A booking request in the staff list (plan 04a section 3). */
export interface CsBookingRequestSummaryDto {
  id: string;
  reference: string;
  /** The real state, awaiting routing included, whatever the bot reads. */
  status: CsBookingRequestState;
  createdAt: string;
  expiresAt: string;
  branchId: string | null;
  originId: string | null;
  destinationId: string | null;
  category: string | null;
  quantity: DecimalString;
  senderName: string;
  channel: CsSenderChannel | null;
  customerId: string | null;
  /** The request is in the bot's own words: some of its places or type may be unmatched. */
  byNames: boolean;
}

/** The advisory price check of a request's quote, done when staff open it (plan 04a section 1). */
export interface CsRequestPriceCheck {
  /** current: the same card, still approved and valid, gives the same total today; else stale. */
  state: 'current' | 'stale';
  rateCardId: string;
  approvedAt: string | null;
  currency: string;
  unitPrice: DecimalString;
  /** The quote's total, as the bot showed it. */
  quotedTotal: DecimalString | null;
  /** The engine's total today for the request's quantity; null when no card prices it now. */
  totalNow: DecimalString | null;
}

export interface CsBookingRequestStaffDto extends CsBookingRequestSummaryDto {
  profile?: {
    id: string;
    number: string;
    name: string | null;
    phone: string | null;
    phoneVerified?: boolean;
    needsReview?: boolean;
    version: number;
  } | null;
  version: number;
  allowedBranchIds: string[];
  customerNumber: string | null;
  /** The sender's number as the request carries it: contact only, never a proof of an account. */
  contactPhone: string | null;
  consigneeName: string;
  consigneePhone: string;
  handover: (typeof CS_HANDOVERS)[number];
  services: (typeof CS_REQUEST_SERVICES)[number][];
  requestedDate: DateString | null;
  language: 'ar' | 'en' | null;
  /** The names the customer saw, for a request by names. */
  botNames: { origin: CsName; destination: CsName; kind: CsName } | null;
  /** The price the bot says it showed from its own material: a claim, never NOLON's price. */
  botQuotedPrice: { amount: DecimalString; currency: string } | null;
  quoteRef: string | null;
  priceCheck: CsRequestPriceCheck | null;
  routedAt: string | null;
  decidedAt: string | null;
  rejectReasonCode: string | null;
  internalNote: string | null;
  /** The booking staff made on approval, and the currency the customer pays in. */
  bookingId: string | null;
  bookingNumber: string | null;
  paymentCurrency: string | null;
  /** What staff priced on approval: the booking is made with no line (Codex F137-1). */
  approvedPricing: {
    category: string;
    quantity: DecimalString;
    currency: string;
    /** Null: approved with no approved price. */
    total: DecimalString | null;
  } | null;
  actions: { canRoute: boolean; canReject: boolean; canApprove: boolean };
}

/**
 * The pricing inputs of an approval (plan 04a section 1): the final booking's route and mode, and
 * the category, quantity (in the category's unit) and currency staff confirm.
 */
export interface CsPriceInputs {
  originId: string;
  destinationId: string;
  mode: ShippingMode;
  loadType?: LoadType | null;
  category: string;
  quantity: DecimalString;
  currency: CurrencyCode;
}

/**
 * GET /cs-booking-requests/:id/price: the engine's price for these inputs, for staff to confirm.
 * `priced`: one approved card in the category's unit prices it; its fingerprint is what approval
 * sends back. `none`: no approved price (the reason says why), and the fingerprint is null. Never a
 * price of record: the booking carries none.
 */
export interface CsApprovalPriceDto {
  state: 'priced' | 'none';
  reason: 'NO_RATE' | 'UNIT_MISMATCH' | 'AMBIGUOUS' | null;
  rateCardId: string | null;
  approvedAt: string | null;
  currency: string;
  unit: RateUnit | null;
  unitPrice: DecimalString | null;
  minimumCharge: DecimalString | null;
  total: DecimalString | null;
  pricingFingerprint: string | null;
}

/**
 * The booking's own fields on approval. Its route, mode, load type and cargo type come from the
 * pricing inputs, and it is made with no line (Codex F137-1): the booking approved is the cargo
 * staff priced, never a second description of it.
 */
export type CsApproveBooking = Omit<
  CreateBookingRequest,
  | 'customerId'
  | 'originLocationId'
  | 'destinationLocationId'
  | 'mode'
  | 'loadType'
  | 'cargoType'
  | 'items'
> & { customerId?: string };

/**
 * POST /cs-booking-requests/:id/approve: the booking to make (the ordinary create checks, in the
 * request's branch) and the request it approves, in one transaction.
 */
export interface CsApproveRequest {
  profileVersion?: number;
  version: number;
  paymentCurrency: CurrencyCode;
  pricing: CsPriceInputs;
  /** The fingerprint of the price staff saw; null when they saw no approved price. */
  pricingFingerprint: string | null;
  booking: CsApproveBooking;
}

export interface CsRouteRequest {
  version: number;
  branchId: string;
}

export interface CsRejectRequest {
  version: number;
  reasonCode: string;
  internalNote?: string | null;
}
