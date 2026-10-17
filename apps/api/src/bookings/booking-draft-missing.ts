import type {
  BookingDraftDirect,
  BookingDraftFromQuotation,
  BookingDraftItem,
} from '@nolon/shared';
import { linePath, missingOf } from '../drafts/draft-rules.js';

/**
 * What a booking draft still misses before it can be approved (MissingFieldsReview), from a
 * booking's own rules (bookings controller and BookingsService.prepare). A booking draft is saved
 * with only its customer (or its quotation); a person fills in the rest on the review screen.
 */

const DIMENSIONS = ['lengthCm', 'widthCm', 'heightCm'] as const;

/**
 * What one cargo line misses: its cargo type and quantity, the container type of a container
 * line, and the other dimensions when only some are given (they go together).
 */
export function bookingItemMissingFields(item: BookingDraftItem): string[] {
  const given = DIMENSIONS.filter((k) => item[k]);
  return [
    ...missingOf(item, ['cargoType', 'quantity']),
    ...(item.cargoType === 'CONTAINER' && !item.containerTypeCode ? ['containerTypeCode'] : []),
    ...(given.length > 0 && given.length < DIMENSIONS.length
      ? DIMENSIONS.filter((k) => !item[k])
      : []),
  ];
}

/** What a draft's cargo lines miss, as paths (`items[0].quantity`). */
function itemsMissing(items: readonly BookingDraftItem[] | undefined): string[] {
  return (items ?? []).flatMap((item, i) =>
    bookingItemMissingFields(item).map((field) => linePath('items', i, field)),
  );
}

/**
 * A direct booking draft: its route, mode and cargo type, at least one service, and what its
 * lines miss (a booking may have no lines).
 */
export function directBookingMissingFields(values: BookingDraftDirect): string[] {
  return [
    ...missingOf(values, ['originLocationId', 'destinationLocationId', 'mode', 'cargoType']),
    ...((values.services ?? []).length === 0 ? ['services'] : []),
    ...itemsMissing(values.items),
  ];
}

/** A booking draft made from a quotation: route, cargo and services come from it; its lines. */
export function quotedBookingMissingFields(values: BookingDraftFromQuotation): string[] {
  return itemsMissing(values.items);
}
