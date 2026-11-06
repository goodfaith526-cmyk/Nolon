import type {
  BookingService,
  CargoType,
  CreateBookingRequest,
  CustomerKind,
  DateString,
  LoadType,
  LocationKind,
  PriceScope,
  QuotationStatus,
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
  'cs:marketing:read',
  'cs:marketing:revenue:read',
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
  /**
   * Public customer vocabulary (`PUBLIC_SHIPMENT_STATUSES`). Null only for internal-only
   * statuses (e.g. CONSOLIDATED): never treat null as in-progress. Cancelled is `'CANCELLED'`.
   */
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
  /**
   * Plan 14-1, with a signed Telegram assertion only: the sender shared its own contact, and
   * `value` is `phone`.
   */
  phoneEvidence?: { kind: 'TELEGRAM_OWN_CONTACT'; contactUserId: string; value: string };
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

/**
 * How a category is quoted and booked (owner, 2026-11-01): `counted` by pieces (barrels), `volume`
 * by the CBM of the pieces' dimensions (cartons, pallets), `weight` by kilos, `flat` per shipment.
 */
export const CS_PRICING_MODES = ['counted', 'volume', 'weight', 'flat'] as const;
export type CsPricingMode = (typeof CS_PRICING_MODES)[number];

/** The pricing mode a category's default unit implies. */
export function pricingModeOf(unit: RateUnit): CsPricingMode {
  switch (unit) {
    case 'PER_CBM':
      return 'volume';
    case 'PER_KG':
      return 'weight';
    case 'PER_SHIPMENT':
      return 'flat';
    case 'PER_BARREL':
    case 'PER_PIECE':
    case 'PER_PALLET':
    case 'PER_CONTAINER':
      return 'counted';
  }
}

/** The dimensions of one piece, in centimetres (up to 2 decimals), as the customer gave them. */
export interface CsDimensionsDto {
  lengthCm: DecimalString;
  widthCm: DecimalString;
  heightCm: DecimalString;
}

export interface CsCatalogCategoryDto {
  code: string;
  nameAr: string;
  nameEn: string;
  unit: RateUnit;
  /**
   * What the bot must collect: `counted` a number of pieces; `volume` a number of pieces and the
   * dimensions of one (L × W × H in centimetres), NOLON computes the CBM; `weight` kilos; `flat`
   * nothing (one shipment).
   */
  pricingMode: CsPricingMode;
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
  /**
   * Plan 09 amendment 4: the customer service numbers of the branches that have one (every branch,
   * trial 2026-11-06: after departure the destination branch answers), for the bot to show.
   */
  support: { branchId: string; code: string; nameAr: string; nameEn: string; phone: string }[];
  /**
   * The key's branches' drop-off points (active, taking shipments), so the bot can say where an
   * office is before any booking: the same details a request shows once staff name its point.
   */
  dropOffPoints: CsCatalogDropOffDto[];
}

/** A drop-off point in the catalog: its branch, its place (when set) and its public details. */
export interface CsCatalogDropOffDto extends CsDropOffDto {
  branchId: string;
  branchCode: string;
  /** The location the point is at, when staff set one (a city or port of the catalog). */
  placeId: string | null;
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
  /**
   * Counted and flat categories: in the category's unit; without it the answer has no total.
   * Volume categories (`pricingMode: 'volume'`): the number of pieces, whole, required with the
   * three dimensions; NOLON computes the CBM and prices it.
   */
  quantity?: DecimalString;
  /**
   * One piece's dimensions in centimetres (up to 2 decimals), required for a volume category and
   * ignored for the others. Centimetres only: the bot converts what the customer said.
   */
  lengthCm?: DecimalString;
  widthCm?: DecimalString;
  heightCm?: DecimalString;
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
/**
 * POST /cs/quotes (plan 09 section 4): several items of one route, each as GET /cs/quote takes it.
 * The route, mode, load type, currency and date are common; each item names its category and its
 * quantity or (volume category) pieces and dimensions.
 */
export interface CsQuotesRequest extends Omit<
  CsQuoteRequest,
  'category' | 'quantity' | 'lengthCm' | 'widthCm' | 'heightCm'
> {
  items: Pick<CsQuoteRequest, 'category' | 'quantity' | 'lengthCm' | 'widthCm' | 'heightCm'>[];
}

/** Why POST /cs/quotes has no total: an item has no price, or no total, or the currencies differ. */
export type CsQuotesTotalReason = 'ITEM_NOT_PRICED' | 'ITEM_WITHOUT_TOTAL' | 'CURRENCIES_DIFFER';

/** POST /cs/quotations: the quotes the bot gave, saved as one NOLON quotation for its customer. */
export interface CsQuotationSaveRequest {
  /** The quoteRefs of one answer (GET /cs/quote or POST /cs/quotes), 1 to 10. */
  quoteRefs: string[];
}

/** The quotation the quotes were saved in; the same one again for the same quotes. */
export interface CsQuotationSaved {
  quotationId: string;
  /** QT00012: the number staff see in Quotations. */
  number: string;
  status: QuotationStatus;
  currency: CurrencyCode;
  total: DecimalString;
  validUntil: DateString;
  /** False when these quotes were saved before (the same quotation is answered). */
  created: boolean;
}

export interface CsQuotesDto {
  /** In the request's order: the item's quote (its own quoteRef), or why it has none. */
  items: {
    quote: CsQuoteDto | null;
    error: { code: string; message: string; status: number } | null;
  }[];
  /** The items' totals summed, in their one currency; null with `totalReason` otherwise. */
  total: DecimalString | null;
  currency: CurrencyCode | null;
  totalReason: CsQuotesTotalReason | null;
}

export interface CsQuoteDto {
  price: DecimalString;
  currency: CurrencyCode;
  unit: RateUnit;
  minimumCharge: DecimalString;
  /**
   * The billable quantity in `unit`: as asked for a counted or flat category; for a volume category
   * the CBM NOLON computed. A booking request (R3) sends this same number as its `quantity`.
   */
  quantity: DecimalString | null;
  /** max(quantity × price, minimum), rounded to the currency's places; null without a quantity. */
  total: DecimalString | null;
  /** A volume answer echoes what it measured: the pieces, one piece's dimensions, and the CBM. */
  pieces: DecimalString | null;
  dimensions: CsDimensionsDto | null;
  volumeCbm: DecimalString | null;
  includes: (typeof CS_QUOTE_INCLUDES)[number][];
  mode: ShippingMode;
  loadType: LoadType | null;
  transitDays: number | null;
  validTo: DateString | null;
  scope: { origin: PriceScope; destination: PriceScope };
  source: { rateCardId: string; approvedAt: string; quotedOn: DateString };
  quoteRef: string;
  quoteRefExpiresAt: string;
  /** Plan 09 amendment 4: until when this quote holds (the same instant as quoteRefExpiresAt). */
  validUntil: string;
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

/** The bot's customer channels; `web` is the chat on a company's own site (erp-agents docs/web-chat.md). */
export const CS_SENDER_CHANNELS = ['whatsapp', 'telegram', 'web'] as const;
export type CsSenderChannel = (typeof CS_SENDER_CHANNELS)[number];

export const CS_HANDOVERS = ['PICKUP', 'BRANCH_DROP'] as const;

/** At most this many new booking requests per owner per day (UTC); a retry does not count. */
export const CS_DAILY_REQUESTS = 5;

/** A request nobody decided in this long is expired. */
export const CS_REQUEST_TTL_DAYS = 14;

/** Plan 09 section 4: at most this many items in one request. */
export const CS_REQUEST_ITEMS_MAX = 10;

/** Plan 09 section 12: an item outside the standard categories, described by the customer. */
export const CS_OTHER_KIND = 'OTHER';

/** The measurements an item may carry, all optional, never a price input by themselves. */
export interface CsItemMeasures {
  /** The real number of packages (whole), when known. */
  pieces?: number;
  lengthCm?: DecimalString;
  widthCm?: DecimalString;
  heightCm?: DecimalString;
  weightKg?: DecimalString;
}

/** One item of a request by ids: a category and its billable quantity, or an OTHER item. */
export type CsRequestItemInput =
  | (CsItemMeasures & {
      category: string;
      /** The billable quantity in the category's unit (CBM for PER_CBM, kg for PER_KG). */
      quantity: DecimalString;
      /** A quote (R2) of the same key for this item. */
      quoteRef?: string;
    })
  | (CsItemMeasures & { kind: typeof CS_OTHER_KIND; description: string });

/** One item of a request by names: the kind the customer saw, or an OTHER item. */
export type CsNamesItemInput =
  | (CsItemMeasures & { kind: CsName; quantity: number | DecimalString })
  | (CsItemMeasures & { kind: typeof CS_OTHER_KIND; description: string });

/**
 * A booking request (R3, docs/plans/04 section 7.1). With a customer token the owner is the
 * token's customer, and `sender` is refused; without one `sender` is required: a channel identity
 * the key vouches its channel verified, never linked to an account by itself.
 */
export interface CsBookingRequestCreate {
  profileId?: string;
  conversationId?: string;
  /** The profile version the bot saw: another one makes no instant account (staff decide). */
  profileVersion?: number;
  sender?: { channel: CsSenderChannel; id: string };
  /** A number shared for contact only (Telegram's «share my number»). */
  contactPhone?: string;
  originId: string;
  destinationId: string;
  /** One item (the original shape); with `items` it is refused (ITEMS_AND_SINGLE). */
  category?: string;
  /**
   * The billable quantity in the category's unit: pieces for a counted category; for a volume
   * category the CBM the quote answered (`CsQuoteDto.quantity`), which `quoteRef` is checked against.
   */
  quantity?: DecimalString;
  /** Plan 09 section 4: 1 to 10 items in place of `category`/`quantity`. */
  items?: CsRequestItemInput[];
  /**
   * A volume category: the pieces and one piece's dimensions in centimetres the CBM came from,
   * kept for staff. Optional; never a price input.
   */
  pieces?: number;
  lengthCm?: DecimalString;
  widthCm?: DecimalString;
  heightCm?: DecimalString;
  services: (typeof CS_REQUEST_SERVICES)[number][];
  /**
   * Plan 09e section 2: set only when the customer said explicitly that the sender is another
   * person, with that person's name and international phone. That person becomes the booking's
   * customer; the chat owner's own file is never changed.
   */
  otherSender?: CsOtherSender;
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
  /** The profile version the bot saw: another one makes no instant account (staff decide). */
  profileVersion?: number;
  idempotencyKey: string;
  channel: CsSenderChannel;
  origin: CsName;
  destination: CsName;
  /** One item (the original shape); with `items` it is refused (ITEMS_AND_SINGLE). */
  kind?: CsName;
  quantity?: number | DecimalString;
  /** Plan 09 section 4: 1 to 10 items in place of `kind`/`quantity`. */
  items?: CsNamesItemInput[];
  /**
   * Plan 09e section 2: set only when the customer said explicitly that the sender is another
   * person, with that person's name and international phone. That person becomes the booking's
   * customer; the chat owner's own file is never changed.
   */
  otherSender?: CsOtherSender;
  senderName: string;
  /** Digits: on WhatsApp the number WhatsApp verified; on Telegram the one the customer wrote. */
  senderPhone?: string;
  receiverName: string;
  receiverPhone: string;
  handover: (typeof CS_BOT_HANDOVERS)[number];
  /** The price the bot showed from its own material: kept for staff to check, never a price. */
  quotedPrice?: { amount: DecimalString; currency: string } | null;
}

export interface CsOtherSender {
  name: string;
  /** +E.164. */
  phone: string;
}

export interface CsName {
  ar: string;
  en: string;
}

export const CS_BOT_HANDOVERS = ['pickup', 'dropoff'] as const;

/** A request by names reads `pending` while it awaits routing: its bot knows no such state. */
export type CsBookingRequestState =
  | 'awaiting_routing'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  /** Plan 09 section 12 (behind CS_ESTIMATES_ENABLED): staff's estimate awaits the customer. */
  | 'estimated';

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
  /**
   * Plan 09 section 2: the customer asked to cancel after approval (staff decide); closedAt once
   * staff handled it. Null when never asked.
   */
  cancelRequest: CsCancelRequestDto | null;
  /**
   * Plan 09 amendment 4: the total staff approved (NOLON's price, in its pricing currency), once
   * approved; null before, or when staff approved with no engine price. The customer pays in the
   * payment instructions' currency.
   */
  approvedPrice: { amount: DecimalString; currency: CurrencyCode } | null;
  /** Plan 09 section 11: where to bring the shipment, once approved; null before or when none. */
  dropOff: CsDropOffDto | null;
  /** Plan 09 section 12: staff's estimate, while the request is `estimated` only; else null. */
  estimate: CsBotEstimateDto | null;
  /** Plan 09 section 12: how many photos the customer sent (at most CS_REQUEST_PHOTOS_MAX). */
  photoCount: number;
  /**
   * Plan 09 section 3: where the booking is, in the customer's stages. BOOKED while pending or the
   * booking is a draft; the shipment's mapped stage once confirmed. Null when rejected, cancelled
   * or expired, or when staff must answer (attention).
   */
  stage: CsStageDto | null;
  /** 'staff': the bot hands the customer to staff (on hold, cancelled, partly delivered...). */
  attention: 'staff' | null;
  shipment: CsShipmentTrackDto | null;
  /**
   * Trial 2026-11-06: what the customer was billed and paid for this booking's shipment, so the bot
   * answers "did I pay?" from NOLON. Null until the request is approved and its shipment exists.
   */
  payment: CsRequestPaymentDto | null;
  /**
   * Plan 13-5 (owner 2026-11-06): one document for each thing the customer handed over: the
   * waybill for the parcel, once it is received, and a receipt for each payment. Short-lived
   * download links (`GET /cs/documents/:token`, 10 minutes, the same key and owner proof), to a
   * proven owner of an approved request only; null otherwise or while the switch is off.
   */
  documents: CsRequestDocumentsDto | null;
}

/** A short-lived link to a PDF NOLON renders at download (never stored). */
export interface CsDocumentLinkDto {
  url: string;
  expiresAt: string;
}

export interface CsRequestDocumentsDto {
  /** The shipment's waybill, once its goods are received; null before. */
  waybill: CsDocumentLinkDto | null;
  /** A receipt for each posted payment towards the shipment's invoices, oldest first. */
  receipts: (CsDocumentLinkDto & {
    number: string;
    receiptDate: string;
    amount: DecimalString;
    currency: string;
  })[];
}

/**
 * How an approved invoice of a request's shipment stands: `credited` when credit notes cleared it
 * in full (nothing was paid on it), `paid` when nothing is left, `partly_paid` when some was paid.
 */
export type CsRequestInvoiceState = 'open' | 'partly_paid' | 'paid' | 'credited';

export interface CsRequestInvoiceDto {
  number: string;
  /** MAIN, or ADDITIONAL for charges billed after it. */
  kind: 'MAIN' | 'ADDITIONAL';
  invoiceDate: DateString;
  dueDate: DateString;
  currency: CurrencyCode;
  total: DecimalString;
  paid: DecimalString;
  credited: DecimalString;
  balance: DecimalString;
  state: CsRequestInvoiceState;
}

export interface CsRequestPaymentDto {
  /** The shipment's approved invoices (cancelled ones left out), oldest first. */
  invoices: CsRequestInvoiceDto[];
  /**
   * Invoices still being prepared (drafts: no number, amount not final). A window booking's
   * invoice stays a draft until the window collects the payment (plan 13).
   */
  draftInvoices: number;
}

/**
 * GET /cs/booking-requests: one of the proven owner's requests, newest first, for the bot to
 * answer "my bookings" from NOLON (owner, 2026-11-05). The full request is read by its id.
 */
export interface CsOwnBookingRequestDto {
  requestId: string;
  reference: string;
  status: CsBookingRequestState;
  createdAt: string;
  /** The booking's number once approved, else null. */
  bookingNumber: string | null;
  /** The route as the request names it (the catalog's names, else the bot's); null when unknown. */
  origin: { ar: string; en: string } | null;
  destination: { ar: string; en: string } | null;
  /** As on the full request (plan 09 section 3). */
  stage: CsStageDto | null;
  attention: 'staff' | null;
  shipment: CsShipmentTrackDto | null;
}

/**
 * Plan 09 section 12: staff's price for a request with an item outside the standard categories.
 * `version` is what the bot sends back to accept it; the price is valid until `validUntil`.
 */
export interface CsEstimateDto {
  version: number;
  amount: DecimalString;
  currency: CurrencyCode;
  /** The one language given is repeated; null when staff wrote none. */
  note: { ar: string; en: string } | null;
  validUntil: string;
}

/**
 * Codex F171-2: what an estimate prices, for the bot to tell the customer before they accept it:
 * the route (names in both languages), mode and load type staff set, and the services it covers
 * (the request's own). The items are the customer's own, as sent. Null only for an estimate made
 * before terms were recorded, which approval refuses.
 */
export interface CsEstimateTermsDto {
  origin: { code: string; ar: string; en: string };
  destination: { code: string; ar: string; en: string };
  mode: ShippingMode;
  loadType: LoadType | null;
  services: BookingService[];
}

/** The estimate as the bot reads it: bound to `version`, with the terms it prices. */
export type CsBotEstimateDto = CsEstimateDto & { terms: CsEstimateTermsDto | null };

/** POST /cs/booking-requests/:id/accept-estimate: the owner accepts the estimate it was shown. */
export interface CsAcceptEstimateRequest {
  estimateVersion: number;
}

export interface CsEstimateAccepted {
  requestId: string;
  status: CsBookingRequestState;
  acceptedVersion: number;
}

/** POST /cs/booking-requests/:id/photos: one image per call, raw bytes (plan 09 section 12). */
export const CS_REQUEST_PHOTOS_MAX = 10;
export const CS_REQUEST_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const CS_REQUEST_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type CsRequestPhotoType = (typeof CS_REQUEST_PHOTO_TYPES)[number];

export interface CsPhotoUploaded {
  photoId: string;
  contentType: CsRequestPhotoType;
  sizeBytes: number;
  /** The request's photos after this one. */
  photoCount: number;
}

/** A photo as staff list it; its bytes at GET /cs-booking-requests/:id/photos/:photoId. */
export interface CsRequestPhotoDto {
  id: string;
  contentType: CsRequestPhotoType;
  sizeBytes: number;
  createdAt: string;
}

/** POST /cs-booking-requests/:id/estimate: staff price the request (plan 09 section 12). */
/**
 * Codex F171-2: the shipping terms an estimate prices, set by staff with it. Approval books exactly
 * these (and the request's services and items as they were); anything else needs a new estimate
 * the customer accepts again.
 */
export interface CsEstimateTerms {
  originId: string;
  destinationId: string;
  mode: ShippingMode;
  loadType: LoadType | null;
}

export interface CsEstimateRequest {
  version: number;
  amount: DecimalString;
  currency: CurrencyCode;
  terms: Omit<CsEstimateTerms, 'loadType'> & { loadType?: LoadType | null };
  noteAr?: string | null;
  noteEn?: string | null;
  /** After now and at most CS_ESTIMATE_MAX_DAYS ahead; the request expires with it. */
  validUntil: string;
}

export const CS_ESTIMATE_MAX_DAYS = 14;
/** The longest note staff add to an estimate, in each language. */
export const CS_ESTIMATE_NOTE_MAX = 500;

/** A customer stage as the bot shows it (plan 09 section 3). */
export interface CsStageDto {
  code: string;
  ar: string;
  en: string;
  order: number;
}

export interface CsShipmentTrackDto {
  number: string;
  stage: CsStageDto | null;
  city: { ar: string; en: string } | null;
  /** When its status last changed (the latest status event). */
  updatedAt: string;
  /**
   * Plan 09 amendment 4: the public tracking page (what the shipment's QR opens), for the bot to
   * show or draw as a QR; null when NOLON has no public address configured.
   */
  trackingUrl: string | null;
}

/**
 * Plan 09 section 3: shipment statuses that always send the customer to staff (stage null,
 * attention 'staff'). No mapping may give them a stage (Codex F164-1).
 */
export const CUSTOMER_STAGE_STAFF_STATUSES = [
  'ON_HOLD',
  'PARTIALLY_DELIVERED',
  'CANCELLED',
] as const satisfies readonly ShipmentStatus[];

/** The customer stages and the internal statuses they show for (staff master data). */
export interface CustomerStageDto {
  code: string;
  nameAr: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
}

export interface CustomerStageInput {
  nameAr: string;
  nameEn: string;
  sortOrder: number;
  isActive: boolean;
}

export interface CustomerStagesDto {
  stages: CustomerStageDto[];
  /** Every shipment status, with its stage or null (the customer is sent to staff). */
  mapping: { status: ShipmentStatus; stageCode: string | null }[];
}

export interface CsCancelRequestDto {
  requestedAt: string;
  closedAt: string | null;
}

/** POST /cs/booking-requests/:id/cancel (plan 09 section 2): the customer's words, optional. */
export interface CsBookingRequestCancel {
  reason?: string;
}

/** A cancellation done (or done before): the request is cancelled. */
export interface CsBookingRequestCancelled {
  requestId: string;
  reference: string;
  status: 'cancelled';
  cancelledAt: string;
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
  // Plan 09 section 2: cancelled by the customer; approved ones whose customer asked to cancel.
  'cancelled',
  'cancel_requested',
  // Plan 09 section 12: an estimate awaits the customer.
  'estimated',
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
  /** The mode and load type the quote priced: the approval form starts from them. */
  mode: ShippingMode;
  loadType: LoadType | null;
}

export interface CsBookingRequestStaffDto extends CsBookingRequestSummaryDto {
  /** Volume requests: pieces and one piece's dimensions (cm) behind the billable CBM quantity. */
  pieces: number | null;
  dimensions: CsDimensionsDto | null;
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
  /**
   * Plan 09 section 4: the request's items as sent (empty for a request in the original one-item
   * shape, which `category`/`quantity` describe), and, once approved, the booking line each became.
   */
  items: CsRequestItemDto[];
  /** The approved booking's lines, for staff to complete an item that made none. */
  bookingLines: CsBookingLineDto[];
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
  /** Plan 09 section 2: when the customer cancelled it, and why (their words). */
  cancelledAt: string | null;
  cancelReason: string | null;
  /** The customer asked to cancel after approval: staff cancel the booking or close the ask. */
  cancelRequest: (CsCancelRequestDto & { reason: string | null }) | null;
  /**
   * The instant branch account made or reused when the signed request was saved, or why it waits
   * for staff. Null: not tried (switched off, no signed profile, awaiting routing).
   */
  instantAccount: { outcome: CsInstantAccountOutcome; customerId: string | null } | null;
  /**
   * Plan 09e section 2: the other sender the bot named explicitly, and their customer once linked
   * (when saved with the identity switch on, else on approval). Null: the chat's owner sends.
   */
  otherSender: { name: string; phone: string; customerId: string | null } | null;
  /** Plan 09e section 3: the receiver's customer made or linked on approval, or why none. */
  receiverAccount: { outcome: CsReceiverAccountOutcome; customerId: string | null } | null;
  /** Plan 09 section 11: the drop-off point named (staff view), and the ones staff may name. */
  dropOffId: string | null;
  /** The point named, as staff read it (even if since turned off). */
  dropOffPoint: CsDropOffChoiceDto | null;
  /**
   * Plan 09 section 12: the latest estimate (any state), and the version the customer accepted.
   * Approval of a request with an OTHER item needs `acceptedVersion` = `version` before
   * `validUntil`.
   */
  estimate:
    | (CsEstimateDto & {
        acceptedVersion: number | null;
        acceptedAt: string | null;
        /** The terms it prices (Codex F171-2); null for none recorded, which approval refuses. */
        terms: CsEstimateTerms | null;
      })
    | null;
  photos: CsRequestPhotoDto[];
  dropOffChoices: CsDropOffChoiceDto[];
  actions: {
    /** Plan 09 section 11: correct the drop-off point of an approved request. */
    canSetDropOff: boolean;
    /** Plan 09 section 12: price a pending (or estimated) request with an OTHER item. */
    canEstimate: boolean;
    canRoute: boolean;
    canReject: boolean;
    canApprove: boolean;
    canCloseCancelRequest: boolean;
  };
}

export const CS_INSTANT_ACCOUNT_OUTCOMES = [
  'CREATED',
  'REUSED',
  'PROFILE_REVIEW',
  'NAME_MISSING',
  'PROFILE_CHANGED',
  'PHONE_IN_USE',
  'ACCOUNT_INACTIVE',
] as const;
/** What became of a signed bot request's instant account (owner's spec, 2026-11-03). */
export type CsInstantAccountOutcome = (typeof CS_INSTANT_ACCOUNT_OUTCOMES)[number];

export const CS_RECEIVER_ACCOUNT_OUTCOMES = [
  'CREATED',
  'LINKED',
  'PHONE_LOCAL',
  'SAME_AS_SENDER',
  'CUSTOMER_INACTIVE',
  'PHONE_AMBIGUOUS',
] as const;
export type CsReceiverAccountOutcome = (typeof CS_RECEIVER_ACCOUNT_OUTCOMES)[number];

export interface CsRequestItemDto {
  id: string;
  lineNo: number;
  /** Null for an OTHER item, or a by-names kind that matched no category. */
  category: string | null;
  botKind: CsName | null;
  isOther: boolean;
  description: string | null;
  quantity: DecimalString | null;
  pieces: number | null;
  dimensions: CsDimensionsDto | null;
  weightKg: DecimalString | null;
  quoteRef: string | null;
  approvedTotal: DecimalString | null;
  /** The booking line it became; null while it made none (CARGO_INCOMPLETE on confirm). */
  bookingItemId: string | null;
}

export interface CsBookingLineDto {
  id: string;
  lineNo: number;
  cargoType: string;
  quantity: number;
  description: string | null;
}

/** Staff link an item that made no booking line to the line they added (plan 09 section 4). */
export interface CsResolveItem {
  bookingItemId: string;
}

/** Staff mark a customer's cancel ask as handled (plan 09 section 2). */
export interface CsCloseCancelRequest {
  version: number;
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
  | 'dropOffWarehouseId'
> & { customerId?: string };

/**
 * POST /cs-booking-requests/:id/approve: the booking to make (the ordinary create checks, in the
 * request's branch) and the request it approves, in one transaction.
 */
/** One approved line of a request with items: its category, quantity and price fingerprint. */
export interface CsApproveLine {
  category: string;
  quantity: DecimalString;
  pricingFingerprint: string | null;
}

/**
 * Plan 09 section 11: where the customer brings the shipment, as the bot reads it once the request
 * is approved: the point's current details. `address` and `hours` repeat the one language given
 * when only one is set; null when neither is. `mapUrl` is the point's own link, or one built from
 * its map position, or null.
 */
export interface CsDropOffDto {
  name: { ar: string; en: string };
  address: { ar: string; en: string } | null;
  phone: string | null;
  mapUrl: string | null;
  hours: { ar: string; en: string } | null;
}

/** A drop-off point staff may name on approval (plan 09 section 11). */
export interface CsDropOffChoiceDto {
  id: string;
  branchId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  /** Plan 13 section 1: the partner outlet that runs the point, labelled with it; else null. */
  outletName: string | null;
}

/** POST /cs-booking-requests/:id/drop-off: staff correct the point of an approved request. */
export interface CsSetDropOff {
  version: number;
  dropOffId: string;
}

export interface CsApproveRequest {
  /**
   * Plan 09 section 11: the drop-off point named to the customer. Left out: the branch's only
   * active point when it has exactly one, else none.
   */
  dropOffId?: string;
  profileVersion?: number;
  version: number;
  paymentCurrency: CurrencyCode;
  /**
   * The route, mode, load type and currency priced; `category`/`quantity` for a request in the
   * one-item shape. A request with items sends `lines` (one per standard item, in order) instead.
   */
  pricing: Omit<CsPriceInputs, 'category' | 'quantity'> & {
    category?: string;
    quantity?: DecimalString;
  };
  lines?: CsApproveLine[];
  /** The fingerprint of the price staff saw (one-item shape); null when they saw no price. */
  pricingFingerprint?: string | null;
  booking: CsApproveBooking;
  /**
   * A request linked to no customer or profile (e.g. the website chat): the booking's customer is
   * made in the request's branch from the sender name and contact phone the bot sent, in the
   * approval's transaction, instead of staff choosing one. Not with `booking.customerId`.
   */
  newCustomerFromRequest?: true;
  /**
   * Plan 09e section 3: the receiver's international phone (+E.164) when the request has only a
   * local one, for the receiver's own customer (behind CS_RECEIVER_CUSTOMER_ENABLED).
   */
  receiverPhone?: string;
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

/**
 * Plan 09 section 5 (N-C5): the notices NOLON sends to a key's approved endpoint, one stream per
 * request numbered by `sequence`. A notice says only that something changed: the bot reads the
 * truth with GET /cs/booking-requests/:id.
 */
export const CS_WEBHOOK_EVENT_TYPES = [
  'request.approved',
  'request.rejected',
  'request.cancelled',
  'request.cancel_requested',
  'request.estimated',
  'shipment.stage_changed',
  'shipment.delivered',
] as const;
export type CsWebhookEventType = (typeof CS_WEBHOOK_EVENT_TYPES)[number];

/** The JSON body of a notice (the receiver contract of 2026-11-03). */
export interface CsWebhookEventBody {
  eventId: string;
  type: CsWebhookEventType;
  requestId: string;
  sequence: number;
  /** ISO 8601. */
  occurredAt: string;
}

/** The audience the agent project's receiver expects, offered when an endpoint is added. */
export const CS_WEBHOOK_DEFAULT_AUDIENCE = 'erp-agents:nolon';

export const CS_WEBHOOK_ENDPOINT_STATUSES = ['PENDING', 'APPROVED', 'RETIRED'] as const;
export type CsWebhookEndpointStatus = (typeof CS_WEBHOOK_ENDPOINT_STATUSES)[number];

export const CS_OUTBOX_STATUSES = [
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED_BY_POLICY',
] as const;
export type CsOutboxStatus = (typeof CS_OUTBOX_STATUSES)[number];

export interface CsWebhookEndpointDto {
  id: string;
  url: string;
  audience: string;
  status: CsWebhookEndpointStatus;
  createdByName: string;
  createdAt: string;
  approvedByName: string | null;
  approvedAt: string | null;
  retiredAt: string | null;
  /** A pending endpoint the viewer may approve (someone else added it). */
  canApprove: boolean;
}

export interface CsOutboxEventDto {
  id: string;
  requestReference: string;
  sequence: number;
  type: CsWebhookEventType;
  status: CsOutboxStatus;
  attempts: number;
  occurredAt: string;
  nextAttemptAt: string;
  sentAt: string | null;
  /** The receiver's last HTTP status; null when no answer came (network, timeout, refused). */
  lastStatus: number | null;
  lastError: string | null;
}

/** A key's endpoints and its recent notices, for the Administrator. */
export interface CsWebhooksDto {
  /** CS_WEBHOOK_SECRET is set: needed to approve an endpoint. */
  secretConfigured: boolean;
  /** CS_WEBHOOK_WORKER_ENABLED: notices are sent. Off: they wait. */
  workerEnabled: boolean;
  /** CS_WEBHOOK_ALLOWED_HOSTS: the only host names an endpoint may use. */
  allowedHosts: string[];
  endpoints: CsWebhookEndpointDto[];
  counts: Record<CsOutboxStatus, number>;
  /** The latest notices, newest first. */
  recent: CsOutboxEventDto[];
}

export interface CsWebhookEndpointCreate {
  url: string;
  audience: string;
}

/** Plan 14-2: at most this many rows per statement section; `count` and the totals cover all. */
export const CS_STATEMENT_MAX_ROWS = 200;

/** One section of a statement: the newest rows, how many match in all, and whether it was cut. */
export interface CsStatementSection<T> {
  rows: T[];
  count: number;
  truncated: boolean;
}

/** A bot booking request the token holder made (plan 14 F206-1), of any state. */
export interface CsStatementRequestDto {
  reference: string;
  createdAt: string;
  origin: { ar: string; en: string } | null;
  destination: { ar: string; en: string } | null;
  goods: {
    category: { ar: string; en: string } | null;
    quantity: DecimalString;
    unit: string | null;
  };
  status: CsBookingRequestState;
  bookingNumber: string | null;
}

/** A booking of the customer, with its shipment's customer stage. No price, no cost. */
export interface CsStatementBookingDto {
  number: string;
  createdAt: string;
  origin: { ar: string; en: string };
  destination: { ar: string; en: string };
  cargoDescription: string | null;
  status: string;
  shipment: { number: string; stage: CsStageDto | null; deliveredAt: string | null } | null;
}

/** All the period's invoices in one currency, before the row cap (F206-2). */
export interface CsStatementInvoiceTotalDto {
  currency: CurrencyCode;
  count: number;
  total: DecimalString;
  paid: DecimalString;
  credited: DecimalString;
  balance: DecimalString;
}

export interface CsStatementInvoicesDto extends CsStatementSection<CsInvoiceDto> {
  totals: CsStatementInvoiceTotalDto[];
}

/** GET /cs/me/statement (plan 14-2). */
export interface CsStatementDto {
  customer: CsCustomerChoiceDto;
  period: { from: DateString; to: DateString };
  generatedAt: string;
  requests: CsStatementSection<CsStatementRequestDto>;
  bookings: CsStatementSection<CsStatementBookingDto>;
  /** Null for an authorized person's token (CONTACT_PHONE): nothing invoice-derived (F206-3). */
  invoices: CsStatementInvoicesDto | null;
  invoicesHidden: 'CONTACT' | null;
}
