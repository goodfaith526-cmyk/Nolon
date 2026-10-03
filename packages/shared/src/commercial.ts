import type { CurrencyCode, DecimalString } from './currencies.js';
import type { Locale } from './locales.js';

/**
 * Commercial cycle (scope 6 and 7, annex B sections 1 to 3): customers, rates, quotations and
 * bookings. These closed lists are system states and dimensions fixed by the annex, not master
 * data: ports, container types and charge types are tables the client extends.
 */

export const SHIPPING_MODES = ['SEA', 'ROAD'] as const;
export type ShippingMode = (typeof SHIPPING_MODES)[number];

/** Sea only. */
export const LOAD_TYPES = ['FCL', 'LCL'] as const;
export type LoadType = (typeof LOAD_TYPES)[number];

export const CARGO_TYPES = ['CONTAINER', 'PALLET', 'BARREL', 'GENERAL'] as const;
export type CargoType = (typeof CARGO_TYPES)[number];

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

/** GET /master-data: everything the commercial screens need for their dropdowns. */
export interface MasterDataDto {
  locations: LocationDto[];
  containerTypes: CodeNameDto[];
  chargeTypes: CodeNameDto[];
  currencies: CurrencyDto[];
}

export interface LocationInput {
  code: string;
  kind: LocationKind;
  nameEn: string;
  nameAr: string;
  countryCode: string;
  isActive?: boolean;
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
 * A line either references an approved rate card (unit, price and minimum come from the rate)
 * or is a manual line (unit and unitPrice required).
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
  loadType?: LoadType | null;
  cargoType: CargoType;
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

export interface ReasonRequest {
  reason: string;
}
