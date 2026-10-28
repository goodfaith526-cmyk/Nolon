import type { RateCardInput } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type {
  DraftEvidence,
  DraftValues,
  MissingFieldsReview,
  EntryDraftCheck,
  EntryDraftReviewFields,
  EvidenceReviewFields,
} from './drafts.js';

/**
 * A selling rate the staff assistant proposes (entry drafts, drafts.ts). A person approves it on
 * the review screen, which creates a DRAFT rate card with their permissions; the rate is then
 * approved as usual (rates:approve) before a quotation can use it. Or the person rejects it.
 */
export type RateCardDraftRequest = DraftValues<
  Omit<RateCardInput, 'minimumCharge' | 'chargeTypeCode' | 'priceCategoryCode'>,
  | 'originLocationId'
  | 'destinationLocationId'
  | 'mode'
  | 'cargoType'
  | 'unit'
  | 'price'
  | 'currency'
  | 'validFrom'
> & {
  /** On an edit, null clears it (the rate's default then applies); absent when not given. */
  minimumCharge?: DecimalString | null;
  chargeTypeCode?: string | null;
};

/** POST /rate-card-drafts: only the branch is required; the rest may be filled in on review. */
export type RateCardDraftCreateRequest = RateCardDraftRequest & {
  idempotencyKey: string;
  branchId: string;
  /** The staff member's words for the values, shown beside them on the review screen. */
  evidence?: DraftEvidence[];
};

/**
 * PATCH /rate-card-drafts/:id: a person fills in or changes values of an open draft. A value
 * changed this way is the reviewer's own: the staff member's words for it are dropped.
 */
export type RateCardDraftUpdateRequest = Partial<RateCardDraftRequest> & { version: number };

export interface RateCardDraftDto
  extends EntryDraftReviewFields, EvidenceReviewFields, MissingFieldsReview {
  branchCode: string;
  /** Null while the draft misses the location. */
  originCode: string | null;
  destinationCode: string | null;
  request: RateCardDraftRequest;
  check: EntryDraftCheck | null;
  /** The DRAFT rate card the approval created. */
  rateCardId: string | null;
}

export type RateCardDraftListItemDto = Omit<RateCardDraftDto, 'request' | 'check' | 'evidence'> & {
  lineCount: number;
  price: DecimalString | null;
  currency: CurrencyCode | null;
};
