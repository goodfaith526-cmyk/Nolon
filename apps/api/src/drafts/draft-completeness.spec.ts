import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  type Completeness,
  bookingCompleteness,
  customerCompleteness,
  goodsReleaseCompleteness,
  invoiceCompleteness,
  newCustomerBookingCompleteness,
  newCustomerQuotationCompleteness,
  partyCompleteness,
  quotationCompleteness,
  rateCardCompleteness,
  receiptCompleteness,
  requireApprovable,
  shipmentStatusCompleteness,
  tripCompleteness,
} from './draft-completeness.js';

// The approval gate of every entry draft kind (no-required-fields plan, 3.3): what an approval
// requires that the draft does not hold, and what it holds that the record would refuse.

const ID = '6f1c1b5e-0d7e-4c1a-9a51-1f2a3b4c5d6e';
const ID2 = '0b8f6a6e-2a3b-4c5d-8e9f-0a1b2c3d4e5f';
const OK: Completeness = { missing: [], invalid: [] };

/** The 422 a gate's findings make, as the approval answers it. */
function refusal(result: Completeness): Record<string, unknown> {
  try {
    requireApprovable(result);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    expect(http.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    return http.getResponse() as Record<string, unknown>;
  }
  throw new Error('the gate let the draft through');
}

describe('the approval gate', () => {
  it('lets a complete, valid draft through', () => {
    expect(() => requireApprovable(OK)).not.toThrow();
  });

  it('refuses with 422 DRAFT_INCOMPLETE naming what is missing and what is invalid', () => {
    expect(refusal({ missing: ['currency'], invalid: ['lines[0].quantity'] })).toMatchObject({
      statusCode: 422,
      code: 'DRAFT_INCOMPLETE',
      missingFields: ['currency'],
      invalidFields: ['lines[0].quantity'],
      fields: ['currency', 'lines[0].quantity'],
    });
    expect(refusal({ missing: [], invalid: ['phone'] })).toMatchObject({
      missingFields: [],
      invalidFields: ['phone'],
    });
  });
});

describe('quotation', () => {
  const complete = {
    customerId: ID,
    originLocationId: ID,
    destinationLocationId: ID2,
    mode: 'SEA',
    cargoType: 'GENERAL',
    currency: 'USD',
    validUntil: '2030-01-01',
    lines: [{ rateCardId: ID, quantity: '1' }],
  };

  it('names every value a quotation requires on an empty draft', () => {
    expect(quotationCompleteness({})).toEqual({
      missing: [
        'customerId',
        'originLocationId',
        'destinationLocationId',
        'mode',
        'cargoType',
        'currency',
        'validUntil',
        'lines',
      ],
      invalid: [],
    });
  });

  it('asks the charge type and unit of a line priced by hand only', () => {
    expect(
      quotationCompleteness({ ...complete, lines: [{ quantity: '1', unitPrice: '5' }] }).missing,
    ).toEqual(['lines[0].chargeTypeCode', 'lines[0].unit']);
    // A system-priced line (no price, no rate card) needs neither here; pricing checks it.
    expect(quotationCompleteness({ ...complete, lines: [{ quantity: '1' }] })).toEqual(OK);
  });

  it('refuses a malformed quantity, price, currency or date', () => {
    expect(
      quotationCompleteness({
        ...complete,
        currency: 'usd',
        validUntil: '2030-13-01',
        lines: [{ rateCardId: ID, quantity: '0', discount: '-1' }],
      }).invalid,
    ).toEqual(['currency', 'validUntil', 'lines[0].quantity', 'lines[0].discount']);
  });

  it('lets a complete quotation through, notes and terms optional', () => {
    expect(quotationCompleteness(complete)).toEqual(OK);
  });
});

describe('booking', () => {
  const direct = {
    customerId: ID,
    originLocationId: ID,
    destinationLocationId: ID2,
    mode: 'SEA',
    cargoType: 'GENERAL',
    services: ['MAIN_FREIGHT'],
  };

  // Services are not asked for: every booking carries the main freight.
  it('names the customer, route, mode and cargo type of a direct booking', () => {
    expect(bookingCompleteness({}).missing).toEqual([
      'customerId',
      'originLocationId',
      'destinationLocationId',
      'mode',
      'cargoType',
    ]);
    expect(bookingCompleteness(direct)).toEqual(OK);
  });

  it("names a line's type and quantity, a container line's container type, dimensions together", () => {
    expect(
      bookingCompleteness({
        ...direct,
        items: [
          {},
          { cargoType: 'CONTAINER', quantity: 1 },
          { cargoType: 'GENERAL', quantity: 1, widthCm: '5' },
        ],
      }).missing,
    ).toEqual([
      'items[0].cargoType',
      'items[0].quantity',
      'items[1].containerTypeCode',
      'items[2].lengthCm',
      'items[2].heightCm',
    ]);
  });

  it('takes route, cargo and services of a booking from a quotation from it', () => {
    expect(bookingCompleteness({ quotationId: ID })).toEqual(OK);
    expect(bookingCompleteness({ quotationId: ID, items: [{ quantity: 0 }] })).toEqual({
      missing: ['items[0].cargoType'],
      invalid: ['items[0].quantity'],
    });
  });
});

describe('trip', () => {
  it('names the kind, the route and the shipments; the fleet waits for the kind', () => {
    expect(tripCompleteness({})).toEqual({
      missing: ['kind', 'originLocationId', 'destinationLocationId', 'shipmentIds'],
      invalid: [],
    });
  });

  it('names what an own trip and an external trip need', () => {
    const route = { originLocationId: ID, destinationLocationId: ID2, shipmentIds: [ID] };
    expect(tripCompleteness({ ...route, kind: 'OWN' }).missing).toEqual(['vehicleId', 'driverId']);
    expect(tripCompleteness({ ...route, kind: 'EXTERNAL', carrierId: ID }).missing).toEqual([
      'agreedCost',
      'currency',
    ]);
    expect(tripCompleteness({ ...route, kind: 'OWN', vehicleId: ID, driverId: ID2 })).toEqual(OK);
  });

  it('refuses an unknown kind and a malformed cost', () => {
    expect(
      tripCompleteness({
        kind: 'BOAT',
        originLocationId: ID,
        destinationLocationId: ID2,
        shipmentIds: [ID],
        agreedCost: '1,000',
      }).invalid,
    ).toEqual(['kind', 'agreedCost']);
  });
});

describe('goods release', () => {
  it('names the shipment, the warehouse and the packages', () => {
    expect(goodsReleaseCompleteness({}).missing).toEqual(['shipmentId', 'warehouseId', 'packages']);
    expect(goodsReleaseCompleteness({ shipmentId: ID, warehouseId: ID2, packages: 3 })).toEqual(OK);
  });

  it('refuses no packages, or part of one', () => {
    expect(goodsReleaseCompleteness({ shipmentId: ID, warehouseId: ID2, packages: 0 })).toEqual({
      missing: [],
      invalid: ['packages'],
    });
    expect(
      goodsReleaseCompleteness({ shipmentId: ID, warehouseId: ID2, packages: 1.5 }).invalid,
    ).toEqual(['packages']);
  });
});

describe('customer', () => {
  it('names the kind, the name and the phone; blanks are missing', () => {
    expect(customerCompleteness({}).missing).toEqual(['kind', 'name', 'phone']);
    expect(customerCompleteness({ kind: 'COMPANY', name: '  ', phone: '+971501234567' })).toEqual({
      missing: ['name'],
      invalid: [],
    });
    expect(customerCompleteness({ kind: 'COMPANY', name: 'A', phone: '+971501234567' })).toEqual(
      OK,
    );
  });

  it('refuses an unknown kind and a phone not in +E.164 form', () => {
    expect(customerCompleteness({ kind: 'SHOP', name: 'A', phone: '0501234567' }).invalid).toEqual([
      'kind',
      'phone',
    ]);
  });
});

describe('party', () => {
  it('names the customer and the name; the phone stays optional', () => {
    expect(partyCompleteness({}).missing).toEqual(['customerId', 'name']);
    expect(partyCompleteness({ customerId: ID, name: 'Shipper' })).toEqual(OK);
    expect(partyCompleteness({ customerId: ID, name: 'Shipper', phone: '12' }).invalid).toEqual([
      'phone',
    ]);
  });
});

describe('rate card', () => {
  const complete = {
    originLocationId: ID,
    destinationLocationId: ID2,
    mode: 'SEA',
    cargoType: 'GENERAL',
    unit: 'PER_CBM',
    price: '10',
    currency: 'USD',
    validFrom: '2030-01-01',
  };

  it('names every value a rate requires, and a container rate its container type', () => {
    expect(rateCardCompleteness({}).missing).toEqual([
      'originLocationId',
      'destinationLocationId',
      'mode',
      'cargoType',
      'unit',
      'price',
      'currency',
      'validFrom',
    ]);
    expect(rateCardCompleteness({ ...complete, cargoType: 'CONTAINER' }).missing).toEqual([
      'containerTypeCode',
    ]);
    expect(rateCardCompleteness(complete)).toEqual(OK);
  });

  it('refuses a malformed price, minimum or date', () => {
    expect(
      rateCardCompleteness({ ...complete, price: '-1', minimumCharge: 'x', validTo: '2030-02-30' })
        .invalid,
    ).toEqual(['price', 'minimumCharge', 'validTo']);
  });
});

describe('shipment status', () => {
  it('names the shipment and the status', () => {
    expect(shipmentStatusCompleteness({}).missing).toEqual(['shipmentId', 'status']);
    expect(shipmentStatusCompleteness({ shipmentId: ID, status: 'IN_TRANSIT' })).toEqual(OK);
  });

  it('refuses a status the assistant may not propose', () => {
    for (const status of ['CLOSED', 'ON_HOLD', 'CANCELLED']) {
      expect(shipmentStatusCompleteness({ shipmentId: ID, status }).invalid).toEqual(['status']);
    }
  });
});

describe('invoice', () => {
  const complete = {
    shipmentId: ID,
    customerId: ID2,
    currency: 'USD',
    invoiceDate: '2030-01-01',
    dueDate: '2030-01-31',
    lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '100' }],
  };

  it('names the shipment, customer, currency, dates and at least one line', () => {
    expect(invoiceCompleteness({}).missing).toEqual([
      'shipmentId',
      'customerId',
      'currency',
      'invoiceDate',
      'dueDate',
      'lines',
    ]);
    expect(invoiceCompleteness(complete)).toEqual(OK);
  });

  it("names a line's charge type, quantity and price: a null never reaches prepare", () => {
    expect(invoiceCompleteness({ ...complete, lines: [{}] }).missing).toEqual([
      'lines[0].chargeTypeCode',
      'lines[0].quantity',
      'lines[0].unitPrice',
    ]);
  });

  it('refuses a malformed currency, date, quantity or price', () => {
    expect(
      invoiceCompleteness({
        ...complete,
        currency: 'US',
        dueDate: 'soon',
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '0', unitPrice: '1.23456' }],
      }).invalid,
    ).toEqual(['currency', 'dueDate', 'lines[0].quantity', 'lines[0].unitPrice']);
  });
});

describe('receipt', () => {
  const complete = {
    customerId: ID,
    receiptDate: '2030-01-01',
    currency: 'USD',
    amount: '50',
    cashAccountId: ID2,
    allocations: [],
  };

  it('names the customer, date, currency, amount and cash account; allocations are optional', () => {
    expect(receiptCompleteness({}).missing).toEqual([
      'customerId',
      'receiptDate',
      'currency',
      'amount',
      'cashAccountId',
    ]);
    expect(receiptCompleteness(complete)).toEqual(OK);
  });

  it("names an allocation's invoice and amount, and refuses a malformed amount", () => {
    expect(
      receiptCompleteness({
        ...complete,
        amount: '5O',
        allocations: [{}, { invoiceId: ID, amount: '-2' }],
      }),
    ).toEqual({
      missing: ['allocations[0].invoiceId', 'allocations[0].amount'],
      invalid: ['amount', 'allocations[1].amount'],
    });
  });
});

describe('drafts for a new customer', () => {
  const customer = { kind: 'INDIVIDUAL', name: 'Amal', phone: '+249912345678' };

  it('gates a booking on its customer part and its booking part', () => {
    expect(newCustomerBookingCompleteness({ customer: {}, booking: {} })).toEqual({
      missing: [
        'customer.kind',
        'customer.name',
        'customer.phone',
        'booking.originLocationId',
        'booking.destinationLocationId',
        'booking.mode',
        'booking.cargoType',
      ],
      invalid: [],
    });
    expect(
      newCustomerBookingCompleteness({
        customer: { ...customer, phone: '0912' },
        booking: {
          originLocationId: ID,
          destinationLocationId: ID2,
          mode: 'ROAD',
          cargoType: 'GENERAL',
          services: ['MAIN_FREIGHT'],
          items: [{ cargoType: 'GENERAL', quantity: 2 }],
        },
      }),
    ).toEqual({ missing: [], invalid: ['customer.phone'] });
  });

  it('gates a quotation on its customer part and its quotation part', () => {
    expect(newCustomerQuotationCompleteness({ customer, quotation: {} }).missing).toEqual([
      'quotation.originLocationId',
      'quotation.destinationLocationId',
      'quotation.mode',
      'quotation.cargoType',
      'quotation.currency',
      'quotation.validUntil',
      'quotation.lines',
    ]);
    expect(
      newCustomerQuotationCompleteness({
        customer,
        quotation: {
          originLocationId: ID,
          destinationLocationId: ID2,
          mode: 'SEA',
          cargoType: 'GENERAL',
          currency: 'USD',
          validUntil: '2030-01-01',
          lines: [{ quantity: '1' }],
        },
      }),
    ).toEqual(OK);
  });
});
