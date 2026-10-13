import { BadRequestException, HttpException, type HttpStatus } from '@nestjs/common';
import { E164_PATTERN, type FormRefusal } from '@nolon/shared';
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

/**
 * 400 for a broken business rule on named request fields (paths such as `items.0.lengthCm`): the
 * message says why, `code` lets the form say it in the page language and `fields` lets it mark
 * them, as `parse` does for malformed input. `code` is null when the reason has none.
 */
export function fieldRefusal(
  code: FormRefusal | null,
  message: string,
  fields: readonly string[],
): BadRequestException {
  return new BadRequestException({
    message,
    code: code ?? undefined,
    fields,
    error: 'Bad Request',
    statusCode: 400,
  });
}

/**
 * A refusal that names no field (403, 404, 409, or a 400 on the whole request), with a `code` so
 * the page can say why in its language (with `params` such as the shipment's number); `message`
 * stays the English reason for other clients.
 */
export function codedRefusal(
  status: HttpStatus.BAD_REQUEST | HttpStatus.FORBIDDEN | HttpStatus.CONFLICT,
  code: FormRefusal,
  message: string,
  params: Readonly<Record<string, string>> = {},
): HttpException {
  const error = { 400: 'Bad Request', 403: 'Forbidden', 409: 'Conflict' }[status];
  return new HttpException(
    { message, code, params, fields: [], error, statusCode: status },
    status,
  );
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

/**
 * Paging and free-text search of a list. Strict, like every list and report query extended from
 * it: an unknown filter is a 400, never silently ignored (which would return unfiltered rows).
 */
export const pageQuery = z.strictObject({
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

/**
 * An Excel export's query without its `locale` (read separately for the headers), so the report's
 * own strict query schema can parse the rest.
 */
export function withoutLocale(query: unknown): unknown {
  if (typeof query !== 'object' || query === null) return query;
  return Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'locale'));
}
