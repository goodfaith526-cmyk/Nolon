import {
  FORM_REVIEW_FORMS,
  FORM_REVIEW_MAX_BYTES,
  FORM_REVIEW_MODES,
  type FormReviewForm,
  type FormReviewMode,
  type Permission,
} from '@nolon/shared';
import { z } from 'zod';

// "Review with the assistant": the rules of a kept form, apart from the database.

/** A request path as a refusal names it: `items.0.weightKg`. */
const PATH = /^[A-Za-z][A-Za-z0-9]{0,39}(\.[A-Za-z0-9]{1,40}){0,5}$/;

export const createFormReviewBody = z
  .object({
    form: z.enum(FORM_REVIEW_FORMS),
    mode: z.enum(FORM_REVIEW_MODES),
    values: z
      .record(z.string(), z.unknown())
      .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= FORM_REVIEW_MAX_BYTES, 'Too large'),
    invalidFields: z.array(z.string().regex(PATH)).max(50),
    reason: z.string().trim().max(500),
    customerName: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .strict();

/**
 * The permission saving that form needs: only someone who may save it keeps it for the
 * assistant. A booking added to a container needs what the container's booking route needs.
 */
export function formReviewPermissions(
  form: FormReviewForm,
  mode: FormReviewMode,
): readonly Permission[] {
  if (form === 'quotation') {
    if (mode === 'container') return [];
    return [mode === 'edit' ? 'quotations:update' : 'quotations:create'];
  }
  if (mode === 'container') {
    return ['container_booking:create', 'bookings:create', 'bookings:approve'];
  }
  return [mode === 'edit' ? 'bookings:update' : 'bookings:create'];
}
