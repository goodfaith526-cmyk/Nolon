import type { PartyInput } from './commercial.js';
import type {
  DraftBranchChoice,
  DraftEvidence,
  DraftUpdateRequest,
  DraftValues,
  EntryDraftCheck,
  EntryDraftReviewFields,
  EvidenceReviewFields,
  MissingFieldsReview,
} from './drafts.js';

/**
 * A party (shipper, consignee or notify party) of a customer that the staff assistant proposes
 * (entry drafts, drafts.ts). A person approves it on the review screen, which adds the party to
 * the customer with their permissions; or rejects it. A booking can then name the party.
 */
export type PartyDraftRequest = DraftValues<PartyInput, 'name'>;

/**
 * POST /party-drafts: no value required (a draft is saved with what the user gave). With no
 * customer yet, the draft names its branch.
 */
export type PartyDraftCreateRequest = PartyDraftRequest &
  DraftBranchChoice & {
    idempotencyKey: string;
    customerId?: string | null;
    /** The staff member's words for the values, shown beside them on the review screen. */
    evidence?: DraftEvidence[];
  };

/** PATCH /party-drafts/:id: a customer named must be of the draft's branch. */
export type PartyDraftUpdateRequest = DraftUpdateRequest<
  PartyDraftRequest & { customerId: string | null }
>;

export interface PartyDraftDto
  extends EntryDraftReviewFields, EvidenceReviewFields, MissingFieldsReview {
  /** Null while the draft names no customer yet. */
  customerId: string | null;
  customerNumber: string | null;
  customerName: string | null;
  request: PartyDraftRequest;
  check: EntryDraftCheck | null;
  /** The party the approval added. */
  partyId: string | null;
}

export type PartyDraftListItemDto = Omit<PartyDraftDto, 'request' | 'check' | 'evidence'> & {
  lineCount: number;
};
