import type { CustomerKind } from './commercial.js';
import type { EntryDraftCheck, EntryDraftReviewFields } from './drafts.js';

/**
 * A new customer the staff assistant proposes (entry drafts, drafts.ts), so that a booking or a
 * quotation can follow for someone not in NOLON yet. A person approves it on the review screen,
 * which creates the customer through the usual customer checks (permission, branch, phone or tax
 * number already taken), or rejects it. Only the contact details a person gives in a chat are
 * proposed; terms, credit and tax details are set on the customer afterwards.
 */
export interface CustomerDraftRequest {
  kind: CustomerKind;
  name: string;
  companyName?: string | null;
  phone: string;
  whatsapp?: string | null;
  email?: string | null;
  city?: string | null;
  address?: string | null;
  notes?: string | null;
}

/** POST /customer-drafts: the branch is one of the user's branches. */
export interface CustomerDraftCreateRequest extends CustomerDraftRequest {
  idempotencyKey: string;
  branchId: string;
}

export interface CustomerDraftDto extends EntryDraftReviewFields {
  branchCode: string;
  request: CustomerDraftRequest;
  check: EntryDraftCheck | null;
  customerId: string | null;
  customerNumber: string | null;
}

export type CustomerDraftListItemDto = Omit<CustomerDraftDto, 'request' | 'check'> & {
  lineCount: number;
  phone: string;
};
