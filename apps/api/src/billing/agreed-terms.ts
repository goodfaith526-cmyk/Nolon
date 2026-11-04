import type { BookingService, CargoType, LoadType, RateUnit, ShippingMode } from '@nolon/shared';
import type { Decimal } from '../common/money.js';
import { decimalKey, requestHash } from '../drafts/draft-rules.js';
import { unitQuantity } from './invoice-suggestion.js';

// Plan 12, section 1 (Codex F190-2): what was priced when a price was agreed, pinned on the
// booking as a hash. The automatic invoice uses the agreed price only while the booking, as it is
// at confirmation, still hashes the same. Pure: the services read the inputs and call it.

/** Changes when the fields hashed below change: an older hash then never matches. */
export const AGREED_TERMS = 'agreedTerms/1';
export const AGREED_TERMS_VERSION = 1;

/** A booking line with every field that decides what it is billed. */
export interface AgreedLine {
  id: string;
  lineNo: number;
  cargoType: CargoType;
  priceCategoryCode: string | null;
  quantity: number;
  weightKg: Decimal | null;
  volumeCbm: Decimal | null;
  lengthCm: Decimal | null;
  widthCm: Decimal | null;
  heightCm: Decimal | null;
  containerTypeCode: string | null;
  description: string | null;
}

/** A line of the quotation the price was agreed in. */
export interface AgreedQuotationLine {
  lineNo: number;
  chargeTypeCode: string;
  unit: RateUnit;
  quantity: Decimal;
  unitPrice: Decimal;
  lineTotal: Decimal;
  /** The rate card's container type, for a PER_CONTAINER line priced from one. */
  containerTypeCode: string | null;
  bookingItemId: string | null;
  coversAllItems: boolean;
}

export interface AgreedTermsInput {
  booking: {
    originLocationId: string;
    destinationLocationId: string;
    mode: ShippingMode;
    loadType: LoadType | null;
    cargoType: CargoType;
    services: readonly BookingService[];
    items: readonly AgreedLine[];
  };
  quotation: {
    id: string;
    updatedAt: Date;
    currency: string;
    lines: readonly AgreedQuotationLine[];
  };
}

const byNumber = <T extends { lineNo: number }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.lineNo - b.lineNo);

/**
 * sha256 of a canonical JSON of the agreed terms: the route, mode, load and cargo type and the
 * sorted services; the quotation's id and revision and each of its lines (charge, unit, quantity,
 * price, total, the booking line it prices or the whole booking); every booking line in order with
 * every billable field (cargo type, category, pieces, weight, volume, each dimension, container
 * type, description), decimals canonical and absent as null; and, for each quotation line, the
 * billable quantity its unit takes on these booking lines (unitQuantity). A line changed, added
 * or dropped, a measure changed with the same piece count, or the quotation changed, changes it.
 * The quotation lines hold the accepted amounts, so an estimate's amount is in the hash too.
 */
export function agreedTermsHash(input: AgreedTermsInput): string {
  const { booking, quotation } = input;
  const items = byNumber(booking.items);
  const cargo = items.map((i) => ({
    cargoType: i.cargoType,
    containerTypeCode: i.containerTypeCode,
    quantity: i.quantity,
    weightKg: i.weightKg,
    volumeCbm: i.volumeCbm,
  }));
  return requestHash({
    terms: AGREED_TERMS,
    route: [booking.originLocationId.toLowerCase(), booking.destinationLocationId.toLowerCase()],
    mode: booking.mode,
    loadType: booking.loadType,
    cargoType: booking.cargoType,
    services: [...booking.services].sort(),
    quotation: {
      id: quotation.id.toLowerCase(),
      updatedAt: quotation.updatedAt.toISOString(),
      currency: quotation.currency,
    },
    items: items.map((i) => [
      i.id.toLowerCase(),
      i.cargoType,
      i.priceCategoryCode,
      i.quantity,
      decimalKey(i.weightKg),
      decimalKey(i.volumeCbm),
      decimalKey(i.lengthCm),
      decimalKey(i.widthCm),
      decimalKey(i.heightCm),
      i.containerTypeCode,
      i.description,
    ]),
    lines: byNumber(quotation.lines).map((l) => {
      const billable = unitQuantity(l.unit, cargo, l.containerTypeCode, booking.cargoType);
      return [
        l.chargeTypeCode,
        l.unit,
        decimalKey(l.quantity),
        decimalKey(l.unitPrice),
        decimalKey(l.lineTotal),
        l.bookingItemId === null ? null : l.bookingItemId.toLowerCase(),
        l.coversAllItems,
        decimalKey(billable),
      ];
    }),
  });
}

/**
 * Codex F193-1: whether the quotation priced these goods. A hash that still matches proves only
 * that nothing changed since the price was agreed; a booking made from a quotation may carry other
 * cargo from the start. Each line's quantity must be the billable quantity its unit takes on the
 * goods it prices: its own booking line, or every line for a line of the whole quotation. A line
 * covering all items (an estimate) is the whole booking's agreed amount. A line bound to a booking
 * line that is gone, or a quantity the cargo does not give exactly, does not reconcile.
 */
export function agreedTermsReconciled(input: AgreedTermsInput): boolean {
  const { booking, quotation } = input;
  const cargoOf = (items: readonly AgreedLine[]) =>
    items.map((i) => ({
      cargoType: i.cargoType,
      containerTypeCode: i.containerTypeCode,
      quantity: i.quantity,
      weightKg: i.weightKg,
      volumeCbm: i.volumeCbm,
    }));
  if (quotation.lines.length === 0) return false;
  return quotation.lines.every((l) => {
    if (l.coversAllItems) return true;
    let goods = booking.items;
    if (l.bookingItemId !== null) {
      const id = l.bookingItemId.toLowerCase();
      goods = booking.items.filter((i) => i.id.toLowerCase() === id);
      if (goods.length === 0) return false;
    }
    const billable = unitQuantity(l.unit, cargoOf(goods), l.containerTypeCode, booking.cargoType);
    return billable !== null && billable.eq(l.quantity);
  });
}
