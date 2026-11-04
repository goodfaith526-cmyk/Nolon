import type { DateString, LoadType, LocationKind, RateUnit, ShippingMode } from './commercial.js';
import type { DecimalString } from './currencies.js';

/**
 * The marketing summary (docs/plans/11-marketing-summary.md): GET /marketing/summary, read only,
 * for an API key holding `cs:marketing:read`. Aggregates only: no customer's name, number, phone or
 * single record. Revenue is there only for a key that also holds `cs:marketing:revenue:read`.
 */

/** The longest period one summary covers, in calendar months (from's month to to's month). */
export const MARKETING_MAX_MONTHS = 12;

export interface MarketingPlaceDto {
  id: string;
  code: string;
  kind: LocationKind;
  nameAr: string;
  nameEn: string;
  countryCode: string;
}

export interface MarketingCategoryDto {
  code: string;
  nameAr: string;
  nameEn: string;
  unit: RateUnit;
}

/** A route with an approved freight price valid today, and what it can carry. */
export interface MarketingRouteDto {
  originId: string;
  destinationId: string;
  mode: ShippingMode;
  loadTypes: LoadType[];
  categories: string[];
}

/** An approved freight price valid today, as the bot's quotes read them (no cost). */
export interface MarketingPriceDto {
  originId: string;
  destinationId: string;
  mode: ShippingMode;
  loadType: LoadType | null;
  category: string;
  unit: RateUnit;
  price: DecimalString;
  minimumCharge: DecimalString;
  currency: string;
  validFrom: DateString;
  validTo: DateString | null;
  transitDays: number | null;
}

/**
 * One month, route and shipment type. A route or type the request did not name yet is null. A
 * request or booking with several types counts once under each.
 */
export interface MarketingMonthDto {
  /** YYYY-MM, in the branch's time zone. */
  month: string;
  originId: string | null;
  destinationId: string | null;
  category: string | null;
  /**
   * Booking requests made in the month: by the bots (Telegram, WhatsApp), by the website chat,
   * and bookings staff entered at a branch without a request.
   */
  requests: { total: number; bot: number; website: number; branch: number };
  /** Bookings made in the month, by their status now. */
  bookings: { confirmed: number; cancelled: number };
}

/** Revenue of one month, route and currency: approved invoices less approved credit notes. */
export interface MarketingRevenueDto {
  month: string;
  originId: string;
  destinationId: string;
  currency: string;
  invoiced: DecimalString;
  credited: DecimalString;
  net: DecimalString;
}

export interface MarketingSummaryDto {
  from: DateString;
  to: DateString;
  /** The day the prices are valid on (UTC). */
  pricesOn: DateString;
  places: MarketingPlaceDto[];
  categories: MarketingCategoryDto[];
  routes: MarketingRouteDto[];
  prices: MarketingPriceDto[];
  monthly: MarketingMonthDto[];
  /** Every month of the period, zero included: people whose first customer account was opened. */
  newCustomers: { month: string; count: number }[];
  /** Only for a key holding `cs:marketing:revenue:read`; absent otherwise. */
  revenue?: MarketingRevenueDto[];
}
