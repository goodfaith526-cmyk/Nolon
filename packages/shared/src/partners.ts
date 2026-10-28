import type { CurrencyCode } from './currencies.js';

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
] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];

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
  actions: { canEdit: boolean };
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
}

/** An edit: anything but the branch, which owns the partner's records. */
export interface PartnerUpdateRequest extends Partial<Omit<PartnerInput, 'branchId'>> {
  isActive?: boolean;
}
