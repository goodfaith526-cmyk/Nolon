import type { BookingInput, BookingItemInput } from './commercial.js';
import type { ContainerChoice, DraftContainer } from './commercial-drafts.js';
import type { CustomerDraftRequest } from './customer-drafts.js';
import type {
  DraftEvidence,
  DraftStatus,
  EntryDraftCheck,
  EntryDraftReviewFields,
  EntryDraftSummaryDto,
  EvidenceReviewFields,
} from './drafts.js';

/**
 * A booking the staff assistant proposes for someone not in NOLON yet (entry drafts, drafts.ts),
 * from one form with the new customer's details and the booking's. One request makes a customer
 * draft and this booking draft, linked. A person approves the customer draft first; approving the
 * booking draft then creates an ordinary DRAFT booking for the customer that approval created.
 * A new customer has no shipper, consignee or notify party yet: they are added on the booking.
 */

/** A cargo line of the booking: no dimensions, the measurements as decimal strings. */
export type NewCustomerBookingItem = Pick<
  BookingItemInput,
  'cargoType' | 'containerTypeCode' | 'description' | 'quantity' | 'weightKg' | 'volumeCbm'
>;

/** The booking without its customer and parties; it may name an open container to go in. */
export interface NewCustomerBookingRequest
  extends
    Omit<BookingInput, 'shipperId' | 'consigneeId' | 'notifyPartyId' | 'items'>,
    ContainerChoice {
  items: NewCustomerBookingItem[];
}

/**
 * The words the assistant may give for the customer (kept on the customer draft); every other
 * field it gives words for is the booking's (`originLocationId`, `destinationLocationId`,
 * `items[N].quantity`, `items[N].weightKg`, `items[N].volumeCbm`).
 */
export const NEW_CUSTOMER_BOOKING_CUSTOMER_FIELDS = [
  'branchId',
  'name',
  'phone',
  'whatsapp',
] as const;

/** POST /new-customer-booking-drafts: the branch is one of the user's branches. */
export interface NewCustomerBookingDraftCreateRequest {
  idempotencyKey: string;
  branchId: string;
  customer: CustomerDraftRequest;
  booking: NewCustomerBookingRequest;
  evidence?: DraftEvidence[];
}

/** What the assistant gets back: the booking draft's summary and the customer draft's id. */
export interface NewCustomerBookingDraftSummaryDto extends EntryDraftSummaryDto {
  customerDraftId: string;
}

/** The customer draft the booking waits for, as the booking's review screen shows it. */
export interface NewCustomerBookingDraftCustomer {
  draftId: string;
  status: DraftStatus;
  name: string;
  phone: string;
  /** The customer its approval created. */
  customerId: string | null;
  customerNumber: string | null;
}

export interface NewCustomerBookingDraftDto extends EntryDraftReviewFields, EvidenceReviewFields {
  branchCode: string;
  request: NewCustomerBookingRequest;
  /** NOLON's checks of the booking now (with the customer, once it is approved). */
  check: EntryDraftCheck | null;
  customer: NewCustomerBookingDraftCustomer;
  /** The container the booking goes in on approval (null when none, or when it no longer exists). */
  container: DraftContainer | null;
  /** The DRAFT booking the approval created. */
  bookingId: string | null;
  bookingNumber: string | null;
}

export type NewCustomerBookingDraftListItemDto = Omit<
  NewCustomerBookingDraftDto,
  'request' | 'check' | 'evidence' | 'container'
> & {
  lineCount: number;
};
