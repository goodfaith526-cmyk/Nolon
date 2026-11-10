import type { CurrencyCode, DecimalString } from './currencies.js';

/**
 * Partners of the NOLON network (business model, docs/plans/02-business-model-batch-1.md 3.1):
 * sales outlets, origin consolidators, overseas agents and distributors in Sudan, in any country.
 * Branch-owned: staff see the partners of their branches only. Commissions, settlements and
 * payments come in later batches.
 */
export const PARTNER_KINDS = [
  'SALES_OUTLET',
  'ORIGIN_CONSOLIDATOR',
  'OVERSEAS_AGENT',
  'DISTRIBUTOR',
  /** A person who brings customers (plan 18): paid per shipment, never per registration. */
  'REFERRER',
] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];

/** A referrer's public customer code (plan 18, 3): `r_` + 8 of [a-z0-9]. */
export const REFERRAL_CODE_PATTERN = /^r_[a-z0-9]{8}$/;

/** The longest optional expiry of a referrer's first-shipment commission, in days. */
export const REFERRAL_WINDOW_MAX_DAYS = 3650;

/** A partner as a customer, quotation, booking or shipment names it. */
export interface PartnerRefDto {
  id: string;
  /** NOL-PTR-000001 */
  number: string;
  name: string;
  isActive: boolean;
}

export interface PartnerSummaryDto {
  id: string;
  /** NOL-PTR-000001 */
  number: string;
  kind: PartnerKind;
  branchId: string;
  name: string;
  phone: string | null;
  countryCode: string;
  locationId: string | null;
  isActive: boolean;
}

export interface PartnerDto extends PartnerSummaryDto {
  email: string | null;
  supplierId: string | null;
  /** The supplier's name, when one is linked. */
  supplierName: string | null;
  currency: CurrencyCode;
  notes: string | null;
  /** Referrers only: his live customer code (null for other kinds). */
  referralCode: string | null;
  /** Plan 18, 5: when the broker's chat account was linked (null: none). */
  chatLinkedAt: string | null;
  /** Referrers only: the optional expiry of a customer's first shipment, in days; null: none. */
  referralWindowDays: number | null;
  actions: { canEdit: boolean; canIssueReferralCode: boolean };
}

export interface PartnerInput {
  kind: PartnerKind;
  /** One of the user's branches. */
  branchId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  countryCode: string;
  locationId?: string | null;
  supplierId?: string | null;
  currency: CurrencyCode;
  notes?: string | null;
  /** Referrers only (1 to REFERRAL_WINDOW_MAX_DAYS, or null for no limit). */
  referralWindowDays?: number | null;
}

/** An edit: anything but the branch, which owns the partner's records. */
export interface PartnerUpdateRequest extends Partial<Omit<PartnerInput, 'branchId'>> {
  isActive?: boolean;
}

/** POST /partners/:id/chat-link (plan 18, 5): the broker's private link, shown once. */
export interface PartnerChatLinkDto {
  token: string;
  /** The bot address with the token, when the bot's address is configured. */
  url: string | null;
  expiresAt: string;
}

/** Plan 18, 8: at most this many refused customer adds a broker makes a day (his branch's day). */
export const REFERRER_DAILY_REFUSALS = 20;

/** GET /referrer-portal (plan 18, 8): a referral broker's own screen. No export. */
export interface ReferrerPortalDto {
  /** Null when the login is tied to no active broker: the screen shows nothing else. */
  broker: {
    name: string;
    number: string;
    referralCode: string | null;
    /** The bot link that registers a customer for him, when the bot's address is configured. */
    customerLink: string | null;
  } | null;
  /** The customers he registered, newest first (at most 200): no other detail. */
  customers: {
    name: string;
    /** The last 3 digits only. */
    phoneEnd: string | null;
    referredAt: string;
    shipments: number;
  }[];
  /** His commission rows, newest first (at most 100); a reversal is negative. */
  commissions: {
    date: string;
    customerName: string;
    reason: 'FIRST_SHIPMENT' | 'BROUGHT_IN_PERSON' | null;
    amount: DecimalString;
    currency: CurrencyCode;
    onStatement: boolean;
  }[];
  /** Not yet on a statement, per currency. */
  pending: { currency: CurrencyCode; amount: DecimalString }[];
  /** His statements (not drafts or cancelled), newest first. */
  statements: {
    number: string;
    periodTo: string;
    currency: CurrencyCode;
    total: DecimalString;
    status: 'BILLED' | 'SETTLED';
  }[];
}

/** POST /referrer-portal/customers (plan 18, 3.3): a new customer, name and phone only. */
export interface ReferrerCustomerRequest {
  name: string;
  phone: string;
}
