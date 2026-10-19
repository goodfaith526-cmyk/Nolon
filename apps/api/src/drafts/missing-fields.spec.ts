import { HttpStatus } from '@nestjs/common';
import type {
  BookingDraftDirect,
  QuotationDraftValues,
  RateCardDraftRequest,
  TripDraftValues,
} from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import {
  bookingItemMissingFields,
  directBookingMissingFields,
  quotedBookingMissingFields,
} from '../bookings/booking-draft-missing.js';
import {
  completeQuotation,
  quotationDraftHash,
  quotationMissingFields,
  quotationRequestHash,
} from '../quotations/quotation-drafts.service.js';
import { evidenceAfterEdit, rateMissingFields } from '../rates/rate-card-drafts.service.js';
import { tripMissingFields, tripRequestHash } from '../transport/trip-drafts.service.js';
import { requireApprovable } from './draft-completeness.js';
import { draftIncomplete, patched } from './draft-rules.js';

// Entry drafts saved with missing values (owner decision, 2026-10-17): what each kind still
// misses before an approval, from the record's own required rules.

const ID = '6f1c1b5e-0d7e-4c1a-9a51-1f2a3b4c5d6e';
const ID2 = '0b8f6a6e-2a3b-4c5d-8e9f-0a1b2c3d4e5f';

describe('trip drafts: missing fields', () => {
  const own: TripDraftValues = { branchId: ID, kind: 'OWN', shipmentIds: [] };

  it('names the route, the fleet an own trip needs, and the shipments', () => {
    expect(tripMissingFields(own)).toEqual([
      'originLocationId',
      'destinationLocationId',
      'vehicleId',
      'driverId',
      'shipmentIds',
    ]);
  });

  it('names the carrier, cost and currency an external trip needs', () => {
    expect(
      tripMissingFields({
        ...own,
        kind: 'EXTERNAL',
        originLocationId: ID,
        destinationLocationId: ID2,
        carrierId: ID,
        shipmentIds: [ID],
      }),
    ).toEqual(['agreedCost', 'currency']);
  });

  it('is empty for a complete trip', () => {
    expect(
      tripMissingFields({
        ...own,
        originLocationId: ID,
        destinationLocationId: ID2,
        vehicleId: ID,
        driverId: ID2,
        shipmentIds: [ID],
      }),
    ).toEqual([]);
  });

  it('hashes a missing value as null, and ids whatever their case', () => {
    const values = { ...own, originLocationId: ID };
    expect(tripRequestHash({ ...values, originLocationId: ID.toUpperCase() })).toBe(
      tripRequestHash(values),
    );
    expect(tripRequestHash({ ...values, destinationLocationId: null })).toBe(
      tripRequestHash(values),
    );
    expect(tripRequestHash(own)).not.toBe(tripRequestHash(values));
  });
});

describe('rate card drafts: missing fields', () => {
  it('names every value a rate requires, and a container rate its container type', () => {
    expect(rateMissingFields({})).toEqual([
      'originLocationId',
      'destinationLocationId',
      'mode',
      'cargoType',
      'unit',
      'price',
      'currency',
      'validFrom',
    ]);
    const container: RateCardDraftRequest = {
      originLocationId: ID,
      destinationLocationId: ID2,
      mode: 'SEA',
      cargoType: 'CONTAINER',
      unit: 'PER_CONTAINER',
      price: '10',
      currency: 'USD',
      validFrom: '2030-01-01',
    };
    expect(rateMissingFields(container)).toEqual(['containerTypeCode']);
    expect(rateMissingFields({ ...container, containerTypeCode: '40HC' })).toEqual([]);
  });

  it("drops the staff member's words of a value the reviewer changed, keeps the others", () => {
    const evidence = [
      { field: 'price', quote: 'ten' },
      { field: 'currency', quote: 'dollars' },
      { field: 'branchId', quote: 'Dubai' },
    ];
    const before: RateCardDraftRequest = { price: '10', currency: 'USD' };
    // 10.00 is the same price; a value filled in from nothing has no words to keep.
    expect(evidenceAfterEdit(evidence, before, { ...before, price: '10.00', mode: 'SEA' })).toEqual(
      evidence,
    );
    expect(evidenceAfterEdit(evidence, before, { ...before, price: '11' })).toEqual([
      { field: 'currency', quote: 'dollars' },
      { field: 'branchId', quote: 'Dubai' },
    ]);
  });
});

describe('quotation drafts: missing fields', () => {
  const header: QuotationDraftValues = { customerId: ID, lines: [] };
  const complete: QuotationDraftValues = {
    customerId: ID,
    originLocationId: ID,
    destinationLocationId: ID2,
    mode: 'SEA',
    cargoType: 'GENERAL',
    currency: 'USD',
    validUntil: '2030-01-01',
    lines: [{ chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '5' }],
  };

  it('names the required values and at least one line', () => {
    expect(quotationMissingFields(header)).toEqual([
      'originLocationId',
      'destinationLocationId',
      'mode',
      'cargoType',
      'currency',
      'validUntil',
      'lines',
    ]);
  });

  it("names a line's quantity, and the charge type and unit of a line priced by hand", () => {
    expect(
      quotationMissingFields({
        ...complete,
        lines: [{ rateCardId: ID }, { quantity: '1', unitPrice: '5' }, { quantity: '2' }],
      }),
    ).toEqual(['lines[0].quantity', 'lines[1].chargeTypeCode', 'lines[1].unit']);
    expect(quotationMissingFields(complete)).toEqual([]);
  });

  it('hashes a complete draft as a quotation always was, an incomplete one apart', () => {
    expect(quotationDraftHash(complete)).toBe(quotationRequestHash(completeQuotation(complete)));
    expect(quotationDraftHash({ ...complete, currency: null })).not.toBe(
      quotationDraftHash(complete),
    );
    expect(quotationDraftHash({ ...header, originLocationId: ID.toUpperCase() })).toBe(
      quotationDraftHash({ ...header, originLocationId: ID }),
    );
  });
});

describe('booking drafts: missing fields', () => {
  const direct: BookingDraftDirect = { customerId: ID };

  it('names the route, mode and cargo type of a direct booking (services are optional)', () => {
    expect(directBookingMissingFields(direct)).toEqual([
      'originLocationId',
      'destinationLocationId',
      'mode',
      'cargoType',
    ]);
    expect(
      directBookingMissingFields({
        ...direct,
        originLocationId: ID,
        destinationLocationId: ID2,
        mode: 'SEA',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
      }),
    ).toEqual([]);
  });

  it("names a line's type and quantity, a container line's type, and dimensions together", () => {
    expect(bookingItemMissingFields({})).toEqual(['cargoType', 'quantity']);
    expect(bookingItemMissingFields({ cargoType: 'CONTAINER', quantity: 1 })).toEqual([
      'containerTypeCode',
    ]);
    expect(bookingItemMissingFields({ cargoType: 'GENERAL', quantity: 1, widthCm: '5' })).toEqual([
      'lengthCm',
      'heightCm',
    ]);
    expect(
      quotedBookingMissingFields({
        items: [{ cargoType: 'GENERAL', quantity: 2 }, { quantity: 1 }],
      }),
    ).toEqual(['items[1].cargoType']);
    // A booking from a quotation takes its route, cargo and services from it.
    expect(quotedBookingMissingFields({})).toEqual([]);
  });
});

describe('drafts: edits and incomplete approvals', () => {
  it('replaces the values an edit gives, clears those it sends as null, keeps the others', () => {
    const current = { a: 'x' as string | null, b: 'y' as string | null, c: ['z'] };
    expect(patched(current, { a: null, c: [] })).toEqual({ a: null, b: 'y', c: [] });
    expect(patched(current, { b: undefined })).toEqual(current);
  });

  it('refuses an approval with 422 DRAFT_INCOMPLETE naming each missing value', () => {
    expect(() => requireApprovable({ missing: [], invalid: [] })).not.toThrow();
    const error = draftIncomplete(['originLocationId', 'lines[0].quantity']);
    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(error.getResponse()).toMatchObject({
      code: 'DRAFT_INCOMPLETE',
      missingFields: ['originLocationId', 'lines[0].quantity'],
      fields: ['originLocationId', 'lines[0].quantity'],
      statusCode: 422,
    });
    expect(() => requireApprovable({ missing: ['mode'], invalid: [] })).toThrow();
  });
});
