import type { PartyInput } from './commercial.js';
import type { EntryDraftCheck, EntryDraftReviewFields } from './drafts.js';

/**
 * A party (shipper, consignee or notify party) of a customer that the staff assistant proposes
 * (entry drafts, drafts.ts). A person approves it on the review screen, which adds the party to
 * the customer with their permissions; or rejects it. A booking can then name the party.
 */
export type PartyDraftRequest = PartyInput;

/** POST /party-drafts. */
export interface PartyDraftCreateRequest extends PartyDraftRequest {
  idempotencyKey: string;
  customerId: string;
}

export interface PartyDraftDto extends EntryDraftReviewFields {
  customerId: string;
  customerNumber: string;
  customerName: string;
  request: PartyDraftRequest;
  check: EntryDraftCheck | null;
  /** The party the approval added. */
  partyId: string | null;
}

export type PartyDraftListItemDto = Omit<PartyDraftDto, 'request' | 'check'> & {
  lineCount: number;
};
