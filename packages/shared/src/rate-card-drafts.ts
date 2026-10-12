import type { RateCardInput } from './commercial.js';
import type { EntryDraftCheck, EntryDraftReviewFields } from './drafts.js';

/**
 * A selling rate the staff assistant proposes (entry drafts, drafts.ts). A person approves it on
 * the review screen, which creates a DRAFT rate card with their permissions; the rate is then
 * approved as usual (rates:approve) before a quotation can use it. Or the person rejects it.
 */
export type RateCardDraftRequest = RateCardInput;

/** POST /rate-card-drafts. */
export interface RateCardDraftCreateRequest extends RateCardDraftRequest {
  idempotencyKey: string;
  branchId: string;
}

export interface RateCardDraftDto extends EntryDraftReviewFields {
  branchCode: string;
  originCode: string;
  destinationCode: string;
  request: RateCardDraftRequest;
  check: EntryDraftCheck | null;
  /** The DRAFT rate card the approval created. */
  rateCardId: string | null;
}

export type RateCardDraftListItemDto = Omit<RateCardDraftDto, 'request' | 'check'> & {
  lineCount: number;
};
