import type { CurrencyCode, DecimalString } from './currencies.js';
import type { Locale } from './locales.js';

/**
 * Commercial cycle (scope 6 and 7, annex B sections 1 to 3): customers, rates, quotations and
 * bookings. These closed lists are system states and dimensions fixed by the annex, not master
 * data: ports, container types and charge types are tables the client extends.
 */

/** SEA_ROAD: a sea leg, then a road leg from the port of discharge (owner, 2026-10-19). */
export const SHIPPING_MODES = ['SEA', 'ROAD', 'SEA_ROAD'] as const;
export type ShippingMode = (typeof SHIPPING_MODES)[number];

/** The mode has a sea leg: FCL/LCL apply, and sea statuses and consolidation. */
export function hasSeaLeg(mode: ShippingMode): boolean {
  return mode === 'SEA' || mode === 'SEA_ROAD';
}

/** The mode has a road leg of its own (main freight by road). */
export function hasRoadLeg(mode: ShippingMode): boolean {
  return mode === 'ROAD' || mode === 'SEA_ROAD';
}

/** The mode of a sea leg and a road leg chosen as two ticks; null when neither is ticked. */
export function modeOfLegs(sea: boolean, road: boolean): ShippingMode | null {
  if (sea && road) return 'SEA_ROAD';
  if (sea) return 'SEA';
  if (road) return 'ROAD';
  return null;
}

/** Modes with a sea leg only. */
export const LOAD_TYPES = ['FCL', 'LCL'] as const;
export type LoadType = (typeof LOAD_TYPES)[number];

export const CARGO_TYPES = ['CONTAINER', 'PALLET', 'BARREL', 'GENERAL'] as const;
export type CargoType = (typeof CARGO_TYPES)[number];

/**
 * The load type of a quotation or rate whose FCL/LCL is not chosen (functional review B2): FCL for
 * a container, else LCL, on a mode with a sea leg; none without one. Bookings follow the same rule
 * from their lines (#91). A load type that is chosen, LCL for a container included, is kept.
 */
export function loadTypeOf(mode: ShippingMode, cargoType: CargoType): LoadType | null {
  if (!hasSeaLeg(mode)) return null;
  return cargoType === 'CONTAINER' ? 'FCL' : 'LCL';
}

/**
 * The cargo types offered on a new booking, quotation or rate (owner, 2026-10-19): container,
 * pallet or barrel. GENERAL stays readable on records made before.
 */
export const OFFERED_CARGO_TYPES = [
  'CONTAINER',
  'PALLET',
  'BARREL',
] as const satisfies readonly CargoType[];

export const RATE_UNITS = [
  'PER_CONTAINER',
  'PER_CBM',
  'PER_KG',
  'PER_PALLET',
  'PER_BARREL',
  'PER_PIECE',
  'PER_SHIPMENT',
] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

export const CUSTOMER_KINDS = ['INDIVIDUAL', 'COMPANY'] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

export const LOCATION_KINDS = ['PORT', 'CITY', 'BORDER', 'OTHER'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const RATE_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export type RateStatus = (typeof RATE_STATUSES)[number];

export const QUOTATION_STATUSES = ['DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const BOOKING_STATUSES = ['DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Optional services on a booking; they decide which shipment stages exist (annex B). */
export const BOOKING_SERVICES = [
  'MAIN_FREIGHT',
  'PICKUP',
  'WAREHOUSE',
  'CUSTOMS',
  'INLAND_TRANSPORT',
  'LAST_MILE',
] as const;
export type BookingService = (typeof BOOKING_SERVICES)[number];

/** International (E.164) phone format, e.g. +249912345678 (scope 6). */
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;

/** Calendar date as YYYY-MM-DD. */
export type DateString = string;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * On a list filtered by origin or destination: the locations each filter matched. A city matches
   * itself and the places that serve it (its ports), so a client can say "including Jebel Ali".
   */
  matchedLocations?: RouteMatch;
}

/** The locations a route filter matched (null: no filter on that end). */
export interface RouteMatch {
  originLocationIds: string[] | null;
  destinationLocationIds: string[] | null;
}

// ---------------------------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------------------------

export interface LocationDto {
  id: string;
  code: string;
  kind: LocationKind;
  nameEn: string;
  nameAr: string;
  countryCode: string;
  isActive: boolean;
  /** The city this place serves (a port's city); a lookup by the city also finds it. */
  cityId: string | null;
}

export interface CodeNameDto {
  code: string;
  nameEn: string;
  nameAr: string;
  isActive: boolean;
}

export interface CurrencyDto extends CodeNameDto {
  symbol: string | null;
  decimalPlaces: number;
}

/** A branch by name, for showing which branch a record belongs to (e.g. a shared rate card). */
export interface BranchNameDto {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
}

/** GET /master-data: everything the commercial and shipment screens need for their dropdowns. */
export interface MasterDataDto {
  /** Every branch, by name only. */
  branches: BranchNameDto[];
  locations: LocationDto[];
  containerTypes: CodeNameDto[];
  chargeTypes: CodeNameDto[];
  documentTypes: CodeNameDto[];
  currencies: CurrencyDto[];
}

export interface LocationInput {
  code: string;
  kind: LocationKind;
  nameEn: string;
  nameAr: string;
  countryCode: string;
  isActive?: boolean;
  /** A CITY location this place serves; not for a city itself. */
  cityId?: string | null;
}

export interface CodeNameInput {
  code: string;
  nameEn: string;
  nameAr: string;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

export interface CustomerSummaryDto {
  id: string;
  number: string;
  branchId: string;
  kind: CustomerKind;
  name: string;
  companyName: string | null;
  phone: string;
  isActive: boolean;
}

export interface CustomerContactDto {
  id: string;
  name: string;
  position: string | null;
  phone: string;
  email: string | null;
  idNumber: string | null;
  canInquire: boolean;
  canReceiveCargo: boolean;
  canReceiveDocuments: boolean;
  isPrimary: boolean;
  isActive: boolean;
}

export interface PartyDto {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  countryCode: string | null;
  city: string | null;
  address: string | null;
}

export interface CustomerDto extends CustomerSummaryDto {
  whatsapp: string | null;
  email: string | null;
  countryCode: string | null;
  city: string | null;
  address: string | null;
  taxNumber: string | null;
  preferredCurrency: CurrencyCode | null;
  preferredLocale: Locale;
  paymentTermsDays: number;
  creditLimit: DecimalString | null;
  creditLimitCurrency: CurrencyCode | null;
  notes: string | null;
  createdAt: string;
  contacts: CustomerContactDto[];
  parties: PartyDto[];
}

/** The answer to adding a party: the customer, and the id of the party this request created. */
export interface CustomerPartyAddedDto extends CustomerDto {
  addedPartyId: string;
}

export interface CustomerInput {
  kind: CustomerKind;
  name: string;
  companyName?: string | null;
  phone: string;
  whatsapp?: string | null;
  email?: string | null;
  countryCode?: string | null;
  city?: string | null;
  address?: string | null;
  taxNumber?: string | null;
  preferredCurrency?: CurrencyCode | null;
  preferredLocale?: Locale;
  paymentTermsDays?: number;
  creditLimit?: DecimalString | null;
  creditLimitCurrency?: CurrencyCode | null;
  notes?: string | null;
}

/** POST /customers: the branch is chosen once and never changes. */
export interface CreateCustomerRequest extends CustomerInput {
  branchId: string;
}

export interface ContactInput {
  name: string;
  position?: string | null;
  phone: string;
  email?: string | null;
  idNumber?: string | null;
  canInquire?: boolean;
  canReceiveCargo?: boolean;
  canReceiveDocuments?: boolean;
  isPrimary?: boolean;
  isActive?: boolean;
}

export interface PartyInput {
  name: string;
  companyName?: string | null;
  phone?: string | null;
  email?: string | null;
  countryCode?: string | null;
  city?: string | null;
  address?: string | null;
}

// ---------------------------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------------------------

export interface RateCardDto {
  id: string;
  branchId: string;
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  loadType: LoadType | null;
  cargoType: CargoType;
  containerTypeCode: string | null;
  chargeTypeCode: string;
  unit: RateUnit;
  price: DecimalString;
  minimumCharge: DecimalString;
  currency: CurrencyCode;
  validFrom: DateString;
  validTo: DateString | null;
  transitDays: number | null;
  notes: string | null;
  status: RateStatus;
  approvedAt: string | null;
  createdAt: string;
}

export interface RateCardInput {
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  loadType?: LoadType | null;
  cargoType: CargoType;
  containerTypeCode?: string | null;
  chargeTypeCode?: string;
  unit: RateUnit;
  price: DecimalString;
  minimumCharge?: DecimalString;
  currency: CurrencyCode;
  validFrom: DateString;
  validTo?: DateString | null;
  transitDays?: number | null;
  notes?: string | null;
}

export interface CreateRateCardRequest extends RateCardInput {
  branchId: string;
}

// ---------------------------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------------------------

export interface QuotationLineDto {
  lineNo: number;
  chargeTypeCode: string;
  description: string | null;
  rateCardId: string | null;
  unit: RateUnit;
  quantity: DecimalString;
  unitPrice: DecimalString;
  minimumCharge: DecimalString;
  discount: DecimalString;
  lineTotal: DecimalString;
}

export interface QuotationSummaryDto {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  customerName: string;
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  currency: CurrencyCode;
  total: DecimalString;
  validUntil: DateString;
  status: QuotationStatus;
  createdAt: string;
}

export interface QuotationDto extends QuotationSummaryDto {
  loadType: LoadType | null;
  cargoType: CargoType;
  cargoDescription: string | null;
  subtotal: DecimalString;
  discountTotal: DecimalString;
  terms: string | null;
  rejectionReason: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  bookingId: string | null;
  lines: QuotationLineDto[];
}

/**
 * A line either references an approved rate card (unit, price and minimum come from the rate),
 * is a manual line (charge type, unit and unitPrice), or gives no rate card and no price: NOLON
 * then prices it from the only approved rate card that matches the quotation and the line's
 * charge type and unit when given (RATE_NO_MATCH, RATE_SEVERAL otherwise).
 */
export interface QuotationLineInput {
  rateCardId?: string | null;
  chargeTypeCode?: string;
  description?: string | null;
  unit?: RateUnit;
  quantity: DecimalString;
  unitPrice?: DecimalString;
  discount?: DecimalString;
}

export interface QuotationInput {
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  loadType?: LoadType | null;
  cargoType: CargoType;
  cargoDescription?: string | null;
  currency: CurrencyCode;
  validUntil: DateString;
  terms?: string | null;
  lines: QuotationLineInput[];
}

/** POST /quotations: the quotation belongs to the customer's branch. */
export interface CreateQuotationRequest extends QuotationInput {
  customerId: string;
}

// ---------------------------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------------------------

export interface BookingItemDto {
  lineNo: number;
  cargoType: CargoType;
  containerTypeCode: string | null;
  description: string | null;
  quantity: number;
  lengthCm: DecimalString | null;
  widthCm: DecimalString | null;
  heightCm: DecimalString | null;
  weightKg: DecimalString | null;
  volumeCbm: DecimalString | null;
}

export interface BookingSummaryDto {
  id: string;
  number: string;
  branchId: string;
  customerId: string;
  customerName: string;
  quotationId: string | null;
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  status: BookingStatus;
  createdAt: string;
}

export interface BookingDto extends BookingSummaryDto {
  loadType: LoadType | null;
  cargoType: CargoType;
  cargoDescription: string | null;
  services: BookingService[];
  shipperId: string | null;
  consigneeId: string | null;
  notifyPartyId: string | null;
  requestedDeparture: DateString | null;
  specialInstructions: string | null;
  cancelReason: string | null;
  confirmedAt: string | null;
  /** Created when the booking is confirmed. */
  shipmentId: string | null;
  shipmentNumber: string | null;
  items: BookingItemDto[];
}

/**
 * One cargo line. When length, width and height are given, the API computes volumeCbm from them
 * and the quantity (CBM calculator, scope 7); otherwise volumeCbm is taken as entered.
 */
export interface BookingItemInput {
  cargoType: CargoType;
  containerTypeCode?: string | null;
  description?: string | null;
  quantity: number;
  lengthCm?: DecimalString | null;
  widthCm?: DecimalString | null;
  heightCm?: DecimalString | null;
  weightKg?: DecimalString | null;
  volumeCbm?: DecimalString | null;
}

export interface BookingInput {
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  /** Omitted: FCL when a line is a container, else LCL (a mode with a sea leg only). */
  loadType?: LoadType | null;
  /** Omitted: the first line's. Required when the booking has no lines. */
  cargoType?: CargoType | null;
  /** Omitted: the lines' descriptions. */
  cargoDescription?: string | null;
  services: BookingService[];
  shipperId?: string | null;
  consigneeId?: string | null;
  notifyPartyId?: string | null;
  requestedDeparture?: DateString | null;
  specialInstructions?: string | null;
  items: BookingItemInput[];
}

export interface CreateBookingRequest extends BookingInput {
  customerId: string;
}

/** POST /quotations/:id/booking: route, cargo and customer come from the approved quotation. */
export interface BookingFromQuotationRequest {
  services?: BookingService[];
  shipperId?: string | null;
  consigneeId?: string | null;
  notifyPartyId?: string | null;
  requestedDeparture?: DateString | null;
  specialInstructions?: string | null;
  items?: BookingItemInput[];
}

/**
 * Where a suggested set of booking parties comes from: the parties of the customer's last booking
 * that named any, or the customer's only party (as consignee) when it has exactly one.
 */
export const BOOKING_PARTY_SOURCES = ['LAST_BOOKING', 'ONLY_PARTY'] as const;
export type BookingPartySource = (typeof BOOKING_PARTY_SOURCES)[number];

/**
 * GET /bookings/party-suggestion?customerId=: parties a new booking of this customer may start
 * from. A suggestion only: the form shows its source, the person may change it, and the API checks
 * on save that each party is the customer's. `source` null: nothing to suggest.
 */
export interface BookingPartySuggestionDto {
  customerId: string;
  source: BookingPartySource | null;
  /** With LAST_BOOKING: the booking the parties come from. */
  bookingId: string | null;
  bookingNumber: string | null;
  shipperId: string | null;
  consigneeId: string | null;
  notifyPartyId: string | null;
}

/**
 * GET /bookings/from-quotation/:quotationId: what a booking made from this approved quotation
 * starts from, for the person to review and save (POST /bookings/from-quotation/:quotationId).
 * Nothing is created by reading it. Route, mode, load type and cargo come from the quotation and
 * stay as they are; `items` holds the container lines the quotation prices per container (its
 * rate card's container type and the line's whole quantity), never its other charges.
 */
export interface BookingFromQuotationPreviewDto {
  quotationId: string;
  quotationNumber: string;
  branchId: string;
  customerId: string;
  customerName: string;
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  loadType: LoadType | null;
  cargoType: CargoType;
  cargoDescription: string | null;
  items: BookingItemInput[];
  parties: BookingPartySuggestionDto;
}

/** Where a new quotation's default currency comes from. */
export const QUOTATION_CURRENCY_SOURCES = ['CUSTOMER', 'BRANCH'] as const;
export type QuotationCurrencySource = (typeof QUOTATION_CURRENCY_SOURCES)[number];

/**
 * GET /quotations/defaults?customerId=: values a new quotation for this customer starts from. The
 * currency is the customer's preferred one when it is active, else its branch's; valid-until is
 * the branch's today plus `validityDays` (configuration). Suggestions for a new form only: the
 * API still takes whatever currency and date are sent.
 */
export interface QuotationDefaultsDto {
  customerId: string;
  currency: CurrencyCode;
  currencySource: QuotationCurrencySource;
  today: DateString;
  validUntil: DateString;
  validityDays: number;
}

export interface ReasonRequest {
  reason: string;
}

/**
 * Why a booking or quotation save was refused, sent with the fields it is about (400 `{ message,
 * code, fields }`) so the form can say it in the page language next to the field.
 */
export const FORM_REFUSALS = [
  'SAME_ROUTE',
  'LOAD_TYPE_SEA_ONLY',
  'SERVICE_REQUIRED',
  'CONTAINER_TYPE_REQUIRED',
  'CONTAINER_TYPE_NOT_APPLICABLE',
  'UNKNOWN_CONTAINER_TYPE',
  'DIMENSIONS_TOGETHER',
  'VOLUME_TOO_LARGE',
  'VALID_UNTIL_PAST',
  // A booking made from a quotation: its route and mode are the quotation's.
  'QUOTED_ROUTE_FIXED',
  'CURRENCY_NOT_ACTIVE',
  'RATE_NOT_USABLE',
  // The system price (no rate card and no price given): none or several rate cards match.
  'RATE_NO_MATCH',
  'RATE_SEVERAL',
  'MANUAL_LINE_INCOMPLETE',
  'UNKNOWN_CHARGE_TYPE',
  'DISCOUNT_EXCEEDS_LINE',
  // Containers (consolidations): params `shipment` and `container` are numbers.
  'CONTAINER_BRANCH_ONLY',
  'CONTAINER_NOT_OPEN',
  'CONTAINER_FULL',
  'SAME_CONTAINER',
  'SHIPMENT_OTHER_BRANCH',
  'SHIPMENT_NOT_LCL_SEA',
  'SHIPMENT_OTHER_PORT',
  'SHIPMENT_PAST_LOADING',
  'SHIPMENT_IN_OTHER_CONTAINER',
  // A booking that names an open container (booking drafts): it must fit the container.
  'CONTAINER_BOOKING_NOT_LCL_SEA',
  'CONTAINER_BOOKING_OTHER_PORT',
  'CONTAINER_BOOKING_NO_MAIN_FREIGHT',
  // An invoice draft line priced by NOLON (no unit price given), from the shipment's quotation.
  'QUOTED_PRICE_OTHER_CURRENCY',
  // A draft invoice moved to another currency without its prices entered anew: `from`, `to`.
  'INVOICE_CURRENCY_REPRICE',
  'QUOTED_PRICE_SEVERAL',
  'PRICE_AS_ONE_UNIT',
  // A receipt (receipt drafts): the cash or bank account, and each allocation to an invoice.
  // Params of the allocation codes: `invoice` (its number), and `balance` and `currency`.
  'CASH_ACCOUNT_NOT_USABLE',
  'ALLOCATION_OTHER_CUSTOMER',
  'ALLOCATION_NOT_APPROVED',
  'ALLOCATION_OTHER_CURRENCY',
  'ALLOCATION_EXCEEDS_BALANCE',
  // An entry draft's branch (drafts saved with missing values): a draft with no customer or
  // shipment yet names its branch; one with them belongs to their branch.
  'BRANCH_REQUIRED',
  'BRANCH_MISMATCH',
  // A location (master data) with a city is in the city's country: params `city` and `country`.
  'CITY_OTHER_COUNTRY',
  // A shipment status its own record sets (Z1): params `status` and `record`
  // (ShipmentStatusRecord). A correction needs shipments:approve and a reason.
  'STATUS_SET_BY_RECORD',
  'STATUS_CORRECTION_FORBIDDEN',
  'STATUS_CORRECTION_REASON_REQUIRED',
] as const;
export type FormRefusal = (typeof FORM_REFUSALS)[number];

/** A non-negative decimal as text, scaled to `scale` places; null when it is not one or has more. */
function scaledDecimal(value: string, scale: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > scale) return null;
  return BigInt(whole + fraction.padEnd(scale, '0'));
}

/**
 * CBM of `quantity` pieces of L × W × H centimetres, rounded half up to 4 places: the same value
 * the API stores (bookings/cbm.ts), for showing while the form is filled in. Null until the three
 * dimensions (up to 2 decimals each) and a whole quantity are given.
 */
export function cbmOf(
  lengthCm: string,
  widthCm: string,
  heightCm: string,
  quantity: string,
): DecimalString | null {
  const dims = [lengthCm, widthCm, heightCm].map((v) => scaledDecimal(v, 2));
  const pieces = scaledDecimal(quantity, 0);
  if (pieces === null || dims.some((d) => d === null)) return null;
  // Each dimension is in hundredths: the product is in 1e-6 cm³; a CBM is 1e6 cm³.
  const product = dims.reduce<bigint>((a, d) => a * (d ?? 0n), pieces);
  // 1e-6 cm³ to 1e-4 CBM: divide by 1e8, half up.
  const tenThousandths = (product + 50_000_000n) / 100_000_000n;
  const text = tenThousandths.toString().padStart(5, '0');
  return `${text.slice(0, -4)}.${text.slice(-4)}`;
}
