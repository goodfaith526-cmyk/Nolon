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

export const createCustomerBody = z.object({ branchId: z.uuid(), ...customerFields }).strict();
export const updateCustomerBody = z.object(customerFields).partial().strict();
