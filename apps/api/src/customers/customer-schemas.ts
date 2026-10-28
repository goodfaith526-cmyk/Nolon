import { CUSTOMER_KINDS, LOCALES } from '@nolon/shared';
import { z } from 'zod';
import {
  amount,
  countryCode,
  currencyCode,
  optionalText,
  phone,
  requiredText,
} from '../common/validation.js';

/** Request shapes of a customer, shared by the API endpoints and the Excel import. */

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  .nullish()
  .or(z.literal('').transform(() => null));

export const customerFields = {
  kind: z.enum(CUSTOMER_KINDS),
  name: requiredText(200),
  companyName: optionalText(200),
  phone,
  whatsapp: phone.nullish(),
  email,
  countryCode: countryCode.nullish(),
  city: optionalText(100),
  address: optionalText(500),
  taxNumber: optionalText(50),
  preferredCurrency: currencyCode.nullish(),
  preferredLocale: z.enum(LOCALES).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  creditLimit: amount.nullish(),
  creditLimitCurrency: currencyCode.nullish(),
  notes: optionalText(2000),
};

// The contact details a person gives in a chat; terms, credit and tax details are set later.
// Each value is checked as a customer's when given; none is required (owner decision,
// 2026-10-17). Customer drafts and new customer quotation and booking drafts take them.
export const customerDraftFields = {
  kind: customerFields.kind.nullish(),
  name: customerFields.name.nullish(),
  companyName: customerFields.companyName,
  phone: customerFields.phone.nullish(),
  whatsapp: customerFields.whatsapp,
  email: customerFields.email,
  city: customerFields.city,
  address: customerFields.address,
  notes: customerFields.notes,
};

/**
 * NOLON screens only (plan 7.2): the customer's segment and the sales outlet that brought it.
 * Customer drafts and the Excel import do not take them.
 */
const screenFields = {
  segmentCode: z.string().trim().toUpperCase().max(20).nullish(),
  acquiredViaOutletId: z.uuid().nullish(),
};

/** A customer row of the Excel import. */
export const importCustomerBody = z.object({ branchId: z.uuid(), ...customerFields }).strict();
export const createCustomerBody = z
  .object({ branchId: z.uuid(), ...customerFields, ...screenFields })
  .strict();
export const updateCustomerBody = z
  .object({ ...customerFields, ...screenFields })
  .partial()
  .strict();

/** A party of a customer (shipper, consignee, notify party): its endpoint and party drafts. */
export const partyBody = z
  .object({
    name: requiredText(200),
    companyName: optionalText(200),
    phone: phone.nullish(),
    email,
    countryCode: countryCode.nullish(),
    city: optionalText(100),
    address: optionalText(500),
  })
  .strict();
