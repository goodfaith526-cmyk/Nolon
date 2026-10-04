import { BadRequestException } from '@nestjs/common';
import { E164_PATTERN } from '@nolon/shared';
import { z } from 'zod';
import { isDateString } from './dates.js';

/** Parses a request body or query with zod; 400 lists the paths of the invalid fields. */
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map((i) => i.path.join('.') || i.message));
  }
  return result.data;
}

/** Non-negative amount with at most 14 integer and 4 decimal digits (fits Decimal(18,4)). */
export const amount = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Invalid amount');

/** Strictly positive quantity, at most 4 decimal places. */
export const quantity = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Invalid quantity')
  .refine((v) => /[1-9]/.test(v), 'Quantity must be positive');

export const dateString = z.string().refine(isDateString, 'Invalid date (YYYY-MM-DD)');

export const phone = z.string().trim().regex(E164_PATTERN, 'Phone must be in +E.164 form');

export const currencyCode = z.string().regex(/^[A-Z]{3}$/);

export const countryCode = z.string().regex(/^[A-Z]{2}$/);

/** Optional free text: trimmed, empty becomes null. */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
}

export function requiredText(max: number) {
  return z.string().trim().min(1).max(max);
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
});

export type PageQuery = z.infer<typeof pageQuery>;

/** Exchange rate: units of a currency per 1 USD, positive, at most 8 decimal places. */
export const fxRate = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,8})?$/, 'Invalid exchange rate')
  .refine((v) => /[1-9]/.test(v), 'Exchange rate must be positive');
