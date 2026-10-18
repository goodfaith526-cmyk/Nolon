import type {
  BookingService,
  CargoType,
  InvoiceSuggestionCurrencySource,
  RateUnit,
} from '@nolon/shared';
import { type Decimal, ZERO, dec, roundMoney } from '../common/money.js';
import { requestHash } from '../drafts/draft-rules.js';

// The rules of an invoice suggested for a shipment (docs/trial-2026-10-18-fixes.md, fix D):
// pure, so InvoicesService.deriveForShipment applies them the same way for the suggestion and
// for createForShipment.

/** Changes when the rules below change, so an older suggestion's fingerprint no longer matches. */
export const SUGGESTION_DERIVATION = 'invoice-suggestion/1';

/**
 * The invoice's currency: the one asked for, else the quotation's (the agreed prices), else the
 * customer's preferred currency, else the branch default.
 */
export function invoiceCurrency(input: {
  requested: string | null;
  quotation: string | null;
  customer: string | null;
  branch: string;
}): { code: string; source: InvoiceSuggestionCurrencySource } {
  if (input.requested) return { code: input.requested, source: 'REQUESTED' };
  if (input.quotation) return { code: input.quotation, source: 'QUOTATION' };
  if (input.customer) return { code: input.customer, source: 'CUSTOMER' };
  return { code: input.branch, source: 'BRANCH' };
}

/** A cargo line of the shipment, as its measures are recorded (weight and volume per line). */
export interface CargoLine {
  cargoType: CargoType;
  containerTypeCode: string | null;
  quantity: number;
  weightKg: Decimal | null;
  volumeCbm: Decimal | null;
}

const total = (values: readonly Decimal[]): Decimal => values.reduce((a, b) => a.plus(b), ZERO);

/** The sum of a measure over every cargo line, or null when any line lacks it (owner D2). */
function measured(items: readonly CargoLine[], measure: (i: CargoLine) => Decimal | null) {
  const values = items.map(measure);
  if (values.length === 0 || values.some((v) => v === null)) return null;
  const sum = total(values as Decimal[]);
  return sum.gt(0) ? sum : null;
}

/** The quantity of the cargo lines of one cargo type, or null when there are none. */
function counted(items: readonly CargoLine[]): Decimal | null {
  const sum = items.reduce((n, i) => n + i.quantity, 0);
  return items.length > 0 && sum > 0 ? dec(sum) : null;
}

/**
 * The quantity a rate's unit takes on this shipment, only where the unit makes it exact; null
 * when a measure it needs is missing or ambiguous (it is never added up from the lines that
 * have it). `containerTypeCode` is the rate's, `cargoType` the shipment's.
 */
export function unitQuantity(
  unit: RateUnit,
  items: readonly CargoLine[],
  containerTypeCode: string | null,
  cargoType: CargoType,
): Decimal | null {
  switch (unit) {
    case 'PER_SHIPMENT':
      return dec(1);
    case 'PER_CONTAINER': {
      const containers = items.filter((i) => i.cargoType === 'CONTAINER');
      if (containers.some((i) => i.containerTypeCode === null)) return null;
      if (containerTypeCode !== null) {
        return counted(containers.filter((i) => i.containerTypeCode === containerTypeCode));
      }
      // A rate for any container type counts them only when the shipment has one type.
      const types = new Set(containers.map((i) => i.containerTypeCode));
      return types.size === 1 ? counted(containers) : null;
    }
    case 'PER_PALLET':
      return counted(items.filter((i) => i.cargoType === 'PALLET'));
    case 'PER_BARREL':
      return counted(items.filter((i) => i.cargoType === 'BARREL'));
    case 'PER_PIECE':
      return counted(items.filter((i) => i.cargoType === cargoType));
    case 'PER_KG':
      return measured(items, (i) => i.weightKg);
    case 'PER_CBM':
      return measured(items, (i) => i.volumeCbm);
  }
}

/**
 * A quotation line as invoiced: its quantity and unit price; where a minimum charge or a discount
 * makes the agreed total differ from quantity × price, the agreed amount as one unit.
 */
export function quotedLine(
  line: { quantity: Decimal; unitPrice: Decimal; lineTotal: Decimal },
  decimalPlaces: number,
): { quantity: Decimal; unitPrice: Decimal } {
  const exact = roundMoney(line.quantity.times(line.unitPrice), decimalPlaces);
  return exact.eq(line.lineTotal)
    ? { quantity: line.quantity, unitPrice: line.unitPrice }
    : { quantity: dec(1), unitPrice: line.lineTotal };
}

/**
 * A rate card line: the rate's price at the quantity; below the rate's minimum charge, the
 * minimum as one unit. With no quantity, the rate's price (the minimum waits for a quantity).
 */
export function ratedLine(
  rate: { price: Decimal; minimumCharge: Decimal },
  quantity: Decimal | null,
  decimalPlaces: number,
): { quantity: Decimal | null; unitPrice: Decimal } {
  if (quantity === null) return { quantity: null, unitPrice: rate.price };
  const amount = roundMoney(quantity.times(rate.price), decimalPlaces);
  return amount.lt(rate.minimumCharge)
    ? { quantity: dec(1), unitPrice: rate.minimumCharge }
    : { quantity, unitPrice: rate.price };
}

/** What a suggestion was derived from: the shipment's quotation, or the rate cards that matched. */
export type SuggestionSource =
  | { quotation: { id: string; updatedAt: Date } }
  | { rateCards: readonly { id: string; updatedAt: Date }[] };

/**
 * sha256 over what the suggestion was derived from: the shipment, its owning branch, the
 * currency, the pricing date, the source revision, each line's charge, unit and service, and
 * the version of these rules.
 */
export function suggestionFingerprint(input: {
  shipmentId: string;
  branchId: string;
  currency: string;
  pricingDate: string;
  source: SuggestionSource;
  lines: readonly { chargeTypeCode: string; unit: RateUnit; service: BookingService | null }[];
}): string {
  const revision = (r: { id: string; updatedAt: Date }) => ({
    id: r.id.toLowerCase(),
    updatedAt: r.updatedAt.toISOString(),
  });
  return requestHash({
    derivation: SUGGESTION_DERIVATION,
    shipmentId: input.shipmentId.toLowerCase(),
    branchId: input.branchId.toLowerCase(),
    currency: input.currency,
    pricingDate: input.pricingDate,
    source:
      'quotation' in input.source
        ? { quotation: revision(input.source.quotation) }
        : {
            rateCards: input.source.rateCards
              .map(revision)
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
          },
    lines: input.lines.map((l) => [l.chargeTypeCode, l.unit, l.service]),
  });
}
