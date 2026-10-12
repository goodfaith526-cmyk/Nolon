// "Review with the assistant": a form NOLON refused to save, kept briefly for the staff
// assistant so it can explain the refusal and, if the person wants, propose the entry as a draft.

/** Forms that offer it. */
export const FORM_REVIEW_FORMS = ['booking', 'quotation'] as const;
export type FormReviewForm = (typeof FORM_REVIEW_FORMS)[number];

/** create: a new record; edit: an existing one; container: a booking added to a consolidation. */
export const FORM_REVIEW_MODES = ['create', 'edit', 'container'] as const;
export type FormReviewMode = (typeof FORM_REVIEW_MODES)[number];

/** How long the assistant may read a kept form. */
export const FORM_REVIEW_TTL_MINUTES = 60;
/** The largest request body kept, in bytes of JSON. */
export const FORM_REVIEW_MAX_BYTES = 16_384;

export interface CreateFormReviewRequest {
  form: FormReviewForm;
  mode: FormReviewMode;
  /** The request body the form sent, as sent. */
  values: Record<string, unknown>;
  /** The request paths the refusal named (ApiError.fields). */
  invalidFields: string[];
  /** The refusal's message. */
  reason: string;
  customerName?: string | null;
}

export interface FormReviewDto {
  id: string;
  form: FormReviewForm;
  mode: FormReviewMode;
  values: Record<string, unknown>;
  invalidFields: string[];
  reason: string;
  customerName: string | null;
  createdAt: string;
  expiresAt: string;
}
