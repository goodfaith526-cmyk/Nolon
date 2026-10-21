import {
  CUSTOMER_KINDS,
  E164_PATTERN,
  SHIPMENT_STATUS_DRAFT_EXCLUDED,
  TRIP_KINDS,
} from '@nolon/shared';
import type { z } from 'zod';
import { amount, currencyCode, dateString, quantity } from '../common/validation.js';
import { draftIncomplete, linePath } from './draft-rules.js';

/**
 * The approval gate of every entry draft kind (docs: no-required-fields plan, 3.3). A draft may be
 * saved with values missing; nothing live or financial is written from it until it is complete
 * and valid. Each kind has one function here, from that kind's own required rules (its record's
 * schema and service): it names the values an approval requires that the draft does not hold
 * (`missing`, including the ones required only in some cases, such as a container type for a
 * container line) and the values it holds that the record would refuse as malformed (`invalid`).
 * Values optional on the record stay optional here. Checks against live data (a customer in the
 * user's branches, an open invoice, a free container...) stay with the record's own `prepare`,
 * which runs after this gate.
 *
 * The same functions give the `missingFields` a draft's reads report, so what the review screen
 * says is missing is exactly what the approval refuses.
 */

export interface Completeness {
  /** Paths of values the approval requires and the draft does not hold (`lines[0].quantity`). */
  missing: string[];
  /** Paths of values the draft holds that the record would refuse as malformed. */
  invalid: string[];
}

/**
 * Refuses an approval (422 DRAFT_INCOMPLETE, nothing recorded) unless the gate found nothing
 * missing or invalid. Every approval calls it first, after its version check and before anything
 * else (prepare, pricing, accounting, the record itself), and again under the draft's row lock.
 */
export function requireApprovable(result: Completeness): void {
  if (result.missing.length > 0 || result.invalid.length > 0) {
    throw draftIncomplete(result.missing, result.invalid);
  }
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

type Maybe<T> = T | null | undefined;

/** A value a draft does not hold: null, absent, or text that is only blanks. */
export function isAbsent(value: unknown): value is null | undefined | '' {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

/** Collects a kind's findings, paths in the order the checks run. */
class Findings {
  readonly missing: string[] = [];
  readonly invalid: string[] = [];

  /** `path` is missing when `value` is absent. */
  require(path: string, value: unknown): this {
    if (isAbsent(value)) this.missing.push(path);
    return this;
  }

  /** `path` is missing when `required` and `value` is absent (a value required in some cases). */
  requireWhen(required: boolean, path: string, value: unknown): this {
    return required ? this.require(path, value) : this;
  }

  /** `path` is invalid when `value` is present and `valid` says it is not. */
  check(path: string, value: unknown, valid: (value: unknown) => boolean): this {
    if (!isAbsent(value) && !valid(value)) this.invalid.push(path);
    return this;
  }

  /** `path` is invalid when `value` is present and does not parse with `schema`. */
  parse(path: string, value: unknown, schema: z.ZodType): this {
    return this.check(path, value, (v) => schema.safeParse(v).success);
  }

  /** Another part's findings, under `prefix` (`customer.` for a new customer's details). */
  merge(part: Completeness, prefix = ''): this {
    this.missing.push(...part.missing.map((path) => prefix + path));
    this.invalid.push(...part.invalid.map((path) => prefix + path));
    return this;
  }

  result(): Completeness {
    return { missing: [...this.missing], invalid: [...this.invalid] };
  }
}

const positiveInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const oneOf =
  (values: readonly string[]) =>
  (v: unknown): boolean =>
    typeof v === 'string' && values.includes(v);

// ---------------------------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------------------------

export interface QuotationLineGate {
  rateCardId?: Maybe<string>;
  chargeTypeCode?: Maybe<string>;
  unit?: Maybe<string>;
  quantity?: Maybe<string>;
  unitPrice?: Maybe<string>;
  discount?: Maybe<string>;
}

/** A quotation's own values (a quotation draft's, or a new customer's), without its customer. */
export interface QuotationGate {
  originLocationId?: Maybe<string>;
  destinationLocationId?: Maybe<string>;
  mode?: Maybe<string>;
  cargoType?: Maybe<string>;
  currency?: Maybe<string>;
  validUntil?: Maybe<string>;
  lines?: Maybe<readonly QuotationLineGate[]>;
}

/**
 * A quotation's values (quotations controller and QuotationsService.prepare): the route, mode,
 * cargo type, currency and validity, at least one line, each line's quantity, and the charge type
 * and unit of a line priced by hand (a unit price and no rate card).
 */
export function quotationValuesCompleteness(values: QuotationGate): Completeness {
  const f = new Findings()
    .require('originLocationId', values.originLocationId)
    .require('destinationLocationId', values.destinationLocationId)
    .require('mode', values.mode)
    .require('cargoType', values.cargoType)
    .require('currency', values.currency)
    .require('validUntil', values.validUntil)
    .parse('currency', values.currency, currencyCode)
    .parse('validUntil', values.validUntil, dateString);
  const lines = values.lines ?? [];
  if (lines.length === 0) f.missing.push('lines');
  lines.forEach((line, i) => {
    const manual = isAbsent(line.rateCardId) && !isAbsent(line.unitPrice);
    f.require(linePath('lines', i, 'quantity'), line.quantity)
      .requireWhen(manual, linePath('lines', i, 'chargeTypeCode'), line.chargeTypeCode)
      .requireWhen(manual, linePath('lines', i, 'unit'), line.unit)
      .parse(linePath('lines', i, 'quantity'), line.quantity, quantity)
      .parse(linePath('lines', i, 'unitPrice'), line.unitPrice, amount)
      .parse(linePath('lines', i, 'discount'), line.discount, amount);
  });
  return f.result();
}

/** A quotation draft: its customer, then the quotation's own values. */
export function quotationCompleteness(
  values: QuotationGate & { customerId?: Maybe<string> },
): Completeness {
  return new Findings()
    .require('customerId', values.customerId)
    .merge(quotationValuesCompleteness(values))
    .result();
}

// ---------------------------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------------------------

export interface BookingItemGate {
  cargoType?: Maybe<string>;
  containerTypeCode?: Maybe<string>;
  quantity?: Maybe<number>;
  lengthCm?: Maybe<string>;
  widthCm?: Maybe<string>;
  heightCm?: Maybe<string>;
  weightKg?: Maybe<string>;
  volumeCbm?: Maybe<string>;
}

const DIMENSIONS = ['lengthCm', 'widthCm', 'heightCm'] as const;

/**
 * What one cargo line misses: its cargo type and quantity, the container type of a container
 * line, and the other dimensions when only some are given (they go together).
 */
export function bookingItemCompleteness(item: BookingItemGate): Completeness {
  const given = DIMENSIONS.filter((k) => !isAbsent(item[k]));
  const f = new Findings()
    .require('cargoType', item.cargoType)
    .require('quantity', item.quantity)
    .requireWhen(item.cargoType === 'CONTAINER', 'containerTypeCode', item.containerTypeCode)
    .check('quantity', item.quantity, positiveInt);
  if (given.length > 0 && given.length < DIMENSIONS.length) {
    for (const k of DIMENSIONS) f.require(k, item[k]);
  }
  return f.result();
}

export function bookingItemsCompleteness(items: Maybe<readonly BookingItemGate[]>): Completeness {
  const f = new Findings();
  (items ?? []).forEach((item, i) => f.merge(bookingItemCompleteness(item), `items[${i}].`));
  return f.result();
}

/** A booking's own values (a booking draft's, or a new customer's), without its customer. */
export interface BookingGate {
  originLocationId?: Maybe<string>;
  destinationLocationId?: Maybe<string>;
  mode?: Maybe<string>;
  cargoType?: Maybe<string>;
  services?: Maybe<readonly string[]>;
  items?: Maybe<readonly BookingItemGate[]>;
}

/**
 * A direct booking's values (bookings controller and BookingsService.prepare): its route, mode
 * and cargo type (else its first line's), and what its lines miss (a booking may have no lines).
 * Services are optional: every booking carries the main freight.
 */
export function bookingValuesCompleteness(values: BookingGate): Completeness {
  const f = new Findings()
    .require('originLocationId', values.originLocationId)
    .require('destinationLocationId', values.destinationLocationId)
    .require('mode', values.mode)
    .require('cargoType', values.cargoType ?? values.items?.[0]?.cargoType);
  return f.merge(bookingItemsCompleteness(values.items)).result();
}

/**
 * A booking draft. A direct one: its customer and the booking's values. One made from a
 * quotation (route, cargo and services come from it): the quotation and its lines.
 */
export function bookingCompleteness(
  values: BookingGate & { customerId?: Maybe<string>; quotationId?: Maybe<string> },
): Completeness {
  if (!isAbsent(values.quotationId)) return bookingItemsCompleteness(values.items);
  return new Findings()
    .require('customerId', values.customerId)
    .merge(bookingValuesCompleteness(values))
    .result();
}

// ---------------------------------------------------------------------------------------------
// Trips and goods releases
// ---------------------------------------------------------------------------------------------

export interface TripGate {
  kind?: Maybe<string>;
  originLocationId?: Maybe<string>;
  destinationLocationId?: Maybe<string>;
  vehicleId?: Maybe<string>;
  driverId?: Maybe<string>;
  carrierId?: Maybe<string>;
  agreedCost?: Maybe<string>;
  currency?: Maybe<string>;
  shipmentIds?: Maybe<readonly string[]>;
}

/**
 * A trip draft (TripsService.prepareCreate and its kind shape): the kind and the route, what the
 * kind needs (an own trip its fleet vehicle and driver; an external one its carrier, agreed cost
 * and currency), and at least one shipment.
 */
export function tripCompleteness(values: TripGate): Completeness {
  const own = values.kind === 'OWN';
  const external = values.kind === 'EXTERNAL';
  const f = new Findings()
    .require('kind', values.kind)
    .check('kind', values.kind, oneOf(TRIP_KINDS))
    .require('originLocationId', values.originLocationId)
    .require('destinationLocationId', values.destinationLocationId)
    .requireWhen(own, 'vehicleId', values.vehicleId)
    .requireWhen(own, 'driverId', values.driverId)
    .requireWhen(external, 'carrierId', values.carrierId)
    .requireWhen(external, 'agreedCost', values.agreedCost)
    .requireWhen(external, 'currency', values.currency)
    .parse('agreedCost', values.agreedCost, amount)
    .parse('currency', values.currency, currencyCode);
  if ((values.shipmentIds ?? []).length === 0) f.missing.push('shipmentIds');
  return f.result();
}

export interface GoodsReleaseGate {
  shipmentId?: Maybe<string>;
  warehouseId?: Maybe<string>;
  packages?: Maybe<number>;
}

/** A goods release draft (warehouse release rules): the shipment, the warehouse, the packages. */
export function goodsReleaseCompleteness(values: GoodsReleaseGate): Completeness {
  return new Findings()
    .require('shipmentId', values.shipmentId)
    .require('warehouseId', values.warehouseId)
    .require('packages', values.packages)
    .check('packages', values.packages, positiveInt)
    .result();
}

// ---------------------------------------------------------------------------------------------
// Customers and parties
// ---------------------------------------------------------------------------------------------

export interface CustomerGate {
  kind?: Maybe<string>;
  name?: Maybe<string>;
  phone?: Maybe<string>;
}

/** A new customer's details (customer schemas): the kind, the name and the phone. */
export function customerCompleteness(values: CustomerGate): Completeness {
  return new Findings()
    .require('kind', values.kind)
    .require('name', values.name)
    .require('phone', values.phone)
    .check('kind', values.kind, oneOf(CUSTOMER_KINDS))
    .check('phone', values.phone, (v) => typeof v === 'string' && E164_PATTERN.test(v))
    .result();
}

export interface PartyGate {
  customerId?: Maybe<string>;
  name?: Maybe<string>;
  phone?: Maybe<string>;
}

/** A party draft (party schemas): the customer it is added to, and its name. */
export function partyCompleteness(values: PartyGate): Completeness {
  return new Findings()
    .require('customerId', values.customerId)
    .require('name', values.name)
    .check('phone', values.phone, (v) => typeof v === 'string' && E164_PATTERN.test(v))
    .result();
}

// ---------------------------------------------------------------------------------------------
// Rates and shipment statuses
// ---------------------------------------------------------------------------------------------

export interface RateCardGate {
  originLocationId?: Maybe<string>;
  destinationLocationId?: Maybe<string>;
  mode?: Maybe<string>;
  cargoType?: Maybe<string>;
  containerTypeCode?: Maybe<string>;
  unit?: Maybe<string>;
  price?: Maybe<string>;
  minimumCharge?: Maybe<string>;
  currency?: Maybe<string>;
  validFrom?: Maybe<string>;
  validTo?: Maybe<string>;
}

/**
 * A rate card draft (rate schemas and RatesService.ruleChecker): its required values, and the
 * container type a container rate needs.
 */
export function rateCardCompleteness(values: RateCardGate): Completeness {
  return new Findings()
    .require('originLocationId', values.originLocationId)
    .require('destinationLocationId', values.destinationLocationId)
    .require('mode', values.mode)
    .require('cargoType', values.cargoType)
    .require('unit', values.unit)
    .require('price', values.price)
    .require('currency', values.currency)
    .require('validFrom', values.validFrom)
    .requireWhen(values.cargoType === 'CONTAINER', 'containerTypeCode', values.containerTypeCode)
    .parse('price', values.price, amount)
    .parse('minimumCharge', values.minimumCharge, amount)
    .parse('currency', values.currency, currencyCode)
    .parse('validFrom', values.validFrom, dateString)
    .parse('validTo', values.validTo, dateString)
    .result();
}

export interface ShipmentStatusGate {
  shipmentId?: Maybe<string>;
  status?: Maybe<string>;
}

/**
 * A shipment status draft: the shipment and the status, never one the assistant may not propose
 * (closing, holding and cancelling stay a person's own actions; a status its own record sets is
 * never proposed). A draft saved before a status was excluded holds it as invalid: its approval is
 * refused (422) until a person picks another status.
 */
export function shipmentStatusCompleteness(values: ShipmentStatusGate): Completeness {
  const excluded: readonly string[] = SHIPMENT_STATUS_DRAFT_EXCLUDED;
  return new Findings()
    .require('shipmentId', values.shipmentId)
    .require('status', values.status)
    .check('status', values.status, (v) => typeof v === 'string' && !excluded.includes(v))
    .result();
}

// ---------------------------------------------------------------------------------------------
// Invoices and receipts
// ---------------------------------------------------------------------------------------------

export interface InvoiceLineGate {
  chargeTypeCode?: Maybe<string>;
  quantity?: Maybe<string>;
  unitPrice?: Maybe<string>;
}

export interface InvoiceGate {
  shipmentId?: Maybe<string>;
  customerId?: Maybe<string>;
  currency?: Maybe<string>;
  invoiceDate?: Maybe<string>;
  dueDate?: Maybe<string>;
  lines?: Maybe<readonly InvoiceLineGate[]>;
}

/**
 * An invoice draft (invoice schemas and InvoicesService.prepareForShipment): the shipment and its
 * customer, the currency and both dates, at least one line, and each line's charge type, quantity
 * and unit price (the price NOLON found, or the one typed): a null never reaches `prepare`.
 */
export function invoiceCompleteness(values: InvoiceGate): Completeness {
  const f = new Findings()
    .require('shipmentId', values.shipmentId)
    .require('customerId', values.customerId)
    .require('currency', values.currency)
    .require('invoiceDate', values.invoiceDate)
    .require('dueDate', values.dueDate)
    .parse('currency', values.currency, currencyCode)
    .parse('invoiceDate', values.invoiceDate, dateString)
    .parse('dueDate', values.dueDate, dateString);
  const lines = values.lines ?? [];
  if (lines.length === 0) f.missing.push('lines');
  lines.forEach((line, i) => {
    f.require(linePath('lines', i, 'chargeTypeCode'), line.chargeTypeCode)
      .require(linePath('lines', i, 'quantity'), line.quantity)
      .require(linePath('lines', i, 'unitPrice'), line.unitPrice)
      .parse(linePath('lines', i, 'quantity'), line.quantity, quantity)
      .parse(linePath('lines', i, 'unitPrice'), line.unitPrice, amount);
  });
  return f.result();
}

export interface ReceiptGate {
  customerId?: Maybe<string>;
  receiptDate?: Maybe<string>;
  currency?: Maybe<string>;
  amount?: Maybe<string>;
  cashAccountId?: Maybe<string>;
  allocations?: Maybe<readonly { invoiceId?: Maybe<string>; amount?: Maybe<string> }[]>;
}

/**
 * A receipt draft (receipt schemas and ReceiptsService.prepareCreate): the customer, the date,
 * the currency, the amount and the cash account, and each allocation's invoice and amount (a
 * receipt may allocate nothing).
 */
export function receiptCompleteness(values: ReceiptGate): Completeness {
  const f = new Findings()
    .require('customerId', values.customerId)
    .require('receiptDate', values.receiptDate)
    .require('currency', values.currency)
    .require('amount', values.amount)
    .require('cashAccountId', values.cashAccountId)
    .parse('receiptDate', values.receiptDate, dateString)
    .parse('currency', values.currency, currencyCode)
    .parse('amount', values.amount, amount);
  (values.allocations ?? []).forEach((allocation, i) => {
    f.require(linePath('allocations', i, 'invoiceId'), allocation.invoiceId)
      .require(linePath('allocations', i, 'amount'), allocation.amount)
      .parse(linePath('allocations', i, 'amount'), allocation.amount, amount);
  });
  return f.result();
}

// ---------------------------------------------------------------------------------------------
// Drafts for a new customer
// ---------------------------------------------------------------------------------------------

/**
 * A booking for a new customer (paths as its create request has them): the customer part
 * (`customer.name`...) and the booking part (`booking.mode`...), the booking's own values as a
 * direct booking draft has them.
 */
export function newCustomerBookingCompleteness(values: {
  customer: CustomerGate;
  booking: BookingGate;
}): Completeness {
  return new Findings()
    .merge(customerCompleteness(values.customer), 'customer.')
    .merge(bookingValuesCompleteness(values.booking), 'booking.')
    .result();
}

/**
 * A quotation for a new customer (paths as its create request has them): the customer part
 * (`customer.name`...) and the quotation part (`quotation.currency`...), the quotation's own
 * values as a quotation draft has them.
 */
export function newCustomerQuotationCompleteness(values: {
  customer: CustomerGate;
  quotation: QuotationGate;
}): Completeness {
  return new Findings()
    .merge(customerCompleteness(values.customer), 'customer.')
    .merge(quotationValuesCompleteness(values.quotation), 'quotation.')
    .result();
}
