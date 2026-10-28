import { CARGO_TYPES, LOAD_TYPES, RATE_UNITS, SHIPPING_MODES } from '@nolon/shared';
import { z } from 'zod';
import { amount, currencyCode, dateString, optionalText } from '../common/validation.js';

/** Request shapes of a rate, shared by the API endpoints and the Excel import. */

export const rateFields = {
  originLocationId: z.uuid(),
  destinationLocationId: z.uuid(),
  mode: z.enum(SHIPPING_MODES),
  loadType: z.enum(LOAD_TYPES).nullish(),
  cargoType: z.enum(CARGO_TYPES),
  containerTypeCode: z.string().trim().toUpperCase().max(10).nullish(),
  chargeTypeCode: z.string().trim().toUpperCase().max(20).optional(),
  unit: z.enum(RATE_UNITS),
  price: amount,
  minimumCharge: amount.optional(),
  currency: currencyCode,
  validFrom: dateString,
  validTo: dateString.nullish(),
  transitDays: z.number().int().min(0).max(365).nullish(),
  notes: optionalText(2000),
};

/**
 * NOLON screens only: the price category a card prices (plan 5.3). Not in rateFields, so rate card
 * drafts and the Excel import keep their shapes (plan 7.2).
 */
const screenFields = {
  ...rateFields,
  priceCategoryCode: z.string().trim().toUpperCase().max(20).nullish(),
};

export const createRateBody = z.object({ branchId: z.uuid(), ...screenFields }).strict();
export const updateRateBody = z.object(screenFields).partial().strict();
