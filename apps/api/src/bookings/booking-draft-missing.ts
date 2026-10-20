import type {
  BookingDraftDirect,
  BookingDraftFromQuotation,
  BookingDraftItem,
} from '@nolon/shared';
import {
  bookingCompleteness,
  bookingItemCompleteness,
  bookingItemsCompleteness,
} from '../drafts/draft-completeness.js';

/**
 * What a booking draft still misses before it can be approved (MissingFieldsReview): the approval
 * gate's missing values (draft-completeness.ts), from a booking's own rules (bookings controller
 * and BookingsService.prepare).
 */

/**
 * What one cargo line misses: its cargo type and quantity, the container type of a container
 * line, and the other dimensions when only some are given (they go together).
 */
export function bookingItemMissingFields(item: BookingDraftItem): string[] {
  return bookingItemCompleteness(item).missing;
}

/**
 * A direct booking draft: its customer, route, mode and cargo type, at least one service, and
 * what its lines miss (a booking may have no lines).
 */
export function directBookingMissingFields(values: BookingDraftDirect): string[] {
  return bookingCompleteness(values).missing;
}

/** A booking draft made from a quotation: route, cargo and services come from it; its lines. */
export function quotedBookingMissingFields(values: BookingDraftFromQuotation): string[] {
  return bookingItemsCompleteness(values.items).missing;
}
