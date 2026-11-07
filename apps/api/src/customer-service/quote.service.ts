import { createHash, randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  CS_QUOTE_INCLUDES,
  type CargoType,
  type CsApprovalPriceDto,
  type CsPriceInputs,
  type CsQuoteChoices,
  type CsQuoteDto,
  type CsQuoteRequest,
  type CsQuotesDto,
  type CsQuotesRequest,
  type CsRequestPriceCheck,
  type CurrencyCode,
  type LoadType,
  type RateUnit,
  type ShippingMode,
  loadTypeOf,
  pricingModeOf,
} from '@nolon/shared';
import { cbmFromDimensions } from '../bookings/cbm.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { addDays, fromDbDateOrNull, todayIn, toDbDate } from '../common/dates.js';
import { FailureLimiter, type LimitRule } from '../common/failure-limiter.js';
import { ZERO, dec, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import type { CsQuote, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeQuotationAmounts } from '../quotations/quotation-totals.js';
import { RatesService } from '../rates/rates.service.js';
import type { ApiClientAuth } from './api-client.guard.js';

/**
 * Per key: at most `max` quotes in 15 minutes, then 15 minutes blocked. Owner, 2026-11-07: no
 * limit on visitors, so this is on only when CS_QUOTES_PER_KEY_15MIN is set (emergency switch).
 */
export function quoteKeyRule(max: number): LimitRule {
  return { maxFailures: max, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000 };
}

/** The charge a quote prices in its first version (plan 5, point 5). */
const FREIGHT = 'FREIGHT';

/** `q_` and 32 URL-safe characters (24 random bytes). */
export function newQuoteRef(): string {
  return `q_${randomBytes(24).toString('base64url')}`;
}

/** 422 QUOTE_AMBIGUOUS: the client asks the customer (mode, currency) or hands over (offer). */
export function ambiguous(choices: CsQuoteChoices): HttpException {
  return new HttpException(
    {
      message: `More than one ${choices.field} matches: give one`,
      code: 'QUOTE_AMBIGUOUS',
      choices,
      statusCode: 422,
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/** The one value of `field` the cards left, the one the client gave, or 422 when several are left. */
export function only<T extends string>(
  field: CsQuoteChoices['field'],
  values: readonly T[],
  given: T | undefined,
): T | null {
  if (given !== undefined) return values.includes(given) ? given : null;
  const distinct = [...new Set(values)].sort();
  if (distinct.length > 1) throw ambiguous({ field, values: distinct });
  return distinct[0] ?? null;
}

function noRate(): HttpException {
  return new HttpException(
    { message: 'No approved price for this route', code: 'NO_RATE', statusCode: 404 },
    HttpStatus.NOT_FOUND,
  );
}

/** The measurement fields a volume quote takes (CsQuoteRequest). */
export type VolumeField = 'quantity' | 'lengthCm' | 'widthCm' | 'heightCm';

/** 422 DIMENSIONS_REQUIRED: the client asks the customer for `fields`, then asks again. */
export function dimensionsRequired(message: string, fields: readonly VolumeField[]): HttpException {
  return new HttpException(
    { message, code: 'DIMENSIONS_REQUIRED', fields: [...fields], statusCode: 422 },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/** What a volume quote measured: the pieces, one piece's dimensions (cm) and the CBM it prices. */
export interface QuoteVolume {
  pieces: number;
  dimensions: { lengthCm: Prisma.Decimal; widthCm: Prisma.Decimal; heightCm: Prisma.Decimal };
  cbm: Prisma.Decimal;
}

/** As many pieces as a booking item takes (bookings.controller itemBody). */
const MAX_PIECES = 100_000;

/**
 * The billable quantity of a volume category (owner, 2026-11-01): the CBM of `quantity` whole
 * pieces of lengthCm × widthCm × heightCm centimetres, as bookings compute it (bookings/cbm.ts,
 * 4 places half up). Anything missing or not a measurement is 422 DIMENSIONS_REQUIRED naming the
 * fields, so the agent asks the customer for exactly those.
 */
export function volumeOf(input: Pick<CsQuoteRequest, VolumeField>): QuoteVolume {
  const { quantity, lengthCm, widthCm, heightCm } = input;
  if (
    quantity === undefined ||
    lengthCm === undefined ||
    widthCm === undefined ||
    heightCm === undefined
  ) {
    const missing = (['quantity', 'lengthCm', 'widthCm', 'heightCm'] as const).filter(
      (field) => input[field] === undefined,
    );
    throw dimensionsRequired(
      "This category is priced by volume: give the number of pieces (quantity) and one piece's " +
        `length, width and height in centimetres. Missing: ${missing.join(', ')}`,
      missing,
    );
  }
  const pieces = dec(quantity);
  if (!pieces.isInteger() || pieces.lte(0) || pieces.gt(MAX_PIECES)) {
    throw dimensionsRequired(
      `For a volume category quantity is the number of pieces: a whole number up to ${MAX_PIECES}`,
      ['quantity'],
    );
  }
  const dimensions = { lengthCm: dec(lengthCm), widthCm: dec(widthCm), heightCm: dec(heightCm) };
  const cbm = cbmFromDimensions(
    dimensions.lengthCm,
    dimensions.widthCm,
    dimensions.heightCm,
    pieces.toNumber(),
  );
  if (cbm.isZero()) {
    throw dimensionsRequired(
      'The pieces measure less than 0.0001 CBM: check the dimensions are in centimetres',
      ['lengthCm', 'widthCm', 'heightCm'],
    );
  }
  // cs_quotes.quantity / totals are Decimal(18, 4): refuse before insert becomes a 500.
  const maxCbm = dec('99999999999999.9999');
  if (cbm.gt(maxCbm)) {
    throw dimensionsRequired(
      'The computed volume is too large to store: check the dimensions are in centimetres',
      ['lengthCm', 'widthCm', 'heightCm', 'quantity'],
    );
  }
  return { pieces: pieces.toNumber(), dimensions, cbm };
}

/**
 * The customer-service price for a route (R2, docs/plans/04 section 5), from NOLON's own engine:
 * the cards systemScopedRates offers (narrowest scope, category before general, the branch that
 * serves the origin first, else every branch),
 * the FREIGHT charge only, and computeQuotationAmounts for the minimum and the rounding. Where
 * the cards differ on what the client left out, it is asked (QUOTE_AMBIGUOUS), never chosen for
 * it. Each answer is kept (cs_quotes) under a random `quoteRef` a booking request names later.
 */
@Injectable()
export class QuoteService {
  /** Null (CS_QUOTES_PER_KEY_15MIN 0, the default): quotes are not limited. */
  private readonly limiter: FailureLimiter | null;

  constructor(
    @Inject(APP_ENV) env: AppEnv,
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataService,
    private readonly rates: RatesService,
    private readonly currencies: CurrenciesService,
  ) {
    const max = env.CS_QUOTES_PER_KEY_15MIN;
    this.limiter = max ? new FailureLimiter(quoteKeyRule(max)) : null;
  }

  async quote(client: ApiClientAuth, input: CsQuoteRequest): Promise<CsQuoteDto> {
    this.requireNotBlocked(client);
    this.limiter?.recordFailure(client.id);
    return this.quoteOne(client, input);
  }

  /**
   * Plan 09 section 4: POST /cs/quotes, several items of one route in one call. Each item is
   * answered as GET /cs/quote answers it (its quote, with its own quoteRef, or its refusal), and
   * each counts as one quote against the key's limit. `total` is the items' sum when every item
   * has a total in one currency; otherwise null, with why.
   */
  async quoteMany(client: ApiClientAuth, input: CsQuotesRequest): Promise<CsQuotesDto> {
    this.requireNotBlocked(client);
    const { items, ...common } = input;
    const answers: CsQuotesDto['items'] = [];
    for (const item of items) {
      this.limiter?.recordFailure(client.id);
      try {
        answers.push({ quote: await this.quoteOne(client, { ...common, ...item }), error: null });
      } catch (e) {
        if (!(e instanceof HttpException)) throw e;
        const body = e.getResponse();
        const code =
          typeof body === 'object' &&
          body !== null &&
          'code' in body &&
          typeof body.code === 'string'
            ? body.code
            : 'NOT_PRICED';
        answers.push({ quote: null, error: { code, message: e.message, status: e.getStatus() } });
      }
    }
    const quotes = answers.map((a) => a.quote);
    const currencies = new Set(quotes.map((q) => q?.currency ?? null));
    let totalReason: CsQuotesDto['totalReason'] = null;
    if (quotes.some((q) => q === null)) totalReason = 'ITEM_NOT_PRICED';
    else if (quotes.some((q) => q?.total === null)) totalReason = 'ITEM_WITHOUT_TOTAL';
    else if (currencies.size > 1) totalReason = 'CURRENCIES_DIFFER';
    const first = quotes[0] ?? null;
    if (totalReason !== null || first === null) {
      return {
        items: answers,
        total: null,
        currency: null,
        totalReason: totalReason ?? 'ITEM_NOT_PRICED',
      };
    }
    const places = (await this.currencies.requireActive(first.currency)).decimalPlaces;
    const total = quotes.reduce((sum, q) => sum.plus(dec(q!.total!)), ZERO);
    return {
      items: answers,
      total: total.toFixed(places),
      currency: first.currency,
      totalReason: null,
    };
  }

  private requireNotBlocked(client: ApiClientAuth): void {
    if (this.limiter?.isBlocked(client.id)) {
      throw new HttpException(
        { message: 'Too many quotes, try again later', code: 'TOO_MANY', statusCode: 429 },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async quoteOne(client: ApiClientAuth, input: CsQuoteRequest): Promise<CsQuoteDto> {
    const today = todayIn('UTC');
    const onDate = input.onDate ?? today;
    if (onDate < today) {
      throw new HttpException(
        { message: 'onDate must be today (UTC) or later', code: 'BAD_DATE', statusCode: 400 },
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.masterData.requireRoute(input.originId, input.destinationId);
    const category = await this.masterData.requirePriceCategory(input.category, null);
    const cargoType = category.cargoType;
    // Owner (2026-11-01): a volume category (PER_CBM) is priced by the CBM of the pieces' dimensions,
    // which are required; a counted, weight or flat category takes `quantity` in its unit as it is
    // and ignores dimensions sent.
    const volume = pricingModeOf(category.defaultUnit) === 'volume' ? volumeOf(input) : null;
    // Plan section 6: one branch serving the origin prices first from its own cards; else every
    // branch's. Bookable when a branch that may serve the origin is one of the key's.
    const candidates = await this.masterData.routingCandidates(input.originId);
    const branchId = candidates.length === 1 ? (candidates[0] ?? null) : null;
    const bookable = candidates.some((id) => client.allowedBranchIds.includes(id));

    const kinds = await this.rates.routeOfferKinds({
      onDate,
      originLocationId: input.originId,
      destinationLocationId: input.destinationId,
      cargoType,
      priceCategoryCode: category.code,
      chargeTypeCode: FREIGHT,
    });
    const mode = only<ShippingMode>(
      'mode',
      kinds.map((k) => k.mode),
      input.mode,
    );
    if (mode === null) throw noRate();
    // As a quotation: a load type left out follows the mode and cargo type.
    const loadType: LoadType | null = input.loadType ?? loadTypeOf(mode, cargoType);
    const currency = only<CurrencyCode>(
      'currency',
      kinds.filter((k) => k.mode === mode && k.loadType === loadType).map((k) => k.currency),
      input.currency,
    );
    if (currency === null) throw noRate();

    const context = {
      branchId,
      onDate,
      currency,
      originLocationId: input.originId,
      destinationLocationId: input.destinationId,
      mode,
      loadType,
      cargoType,
      priceCategoryCode: category.code,
      chargeTypeCode: FREIGHT,
    };
    const offers = await this.rates.systemScopedRates(context);
    if (offers.length === 0) throw noRate();
    // No unit conversion in this version (point 6): a card in another unit is for staff.
    const inUnit = offers.filter((o) => o.rate.unit === category.defaultUnit);
    if (inUnit.length === 0) {
      throw new HttpException(
        {
          message: `The price is not per ${category.defaultUnit}: staff will price it`,
          code: 'UNIT_MISMATCH',
          statusCode: 422,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const [scoped, ...others] = inUnit;
    if (!scoped || others.length > 0) throw ambiguous({ field: 'offer', values: [] });
    const { rate } = scoped;
    if (!rate.approvedAt) throw noRate();

    // The billable quantity: the CBM for a volume category, else what was asked.
    const quantity = volume
      ? volume.cbm
      : input.quantity === undefined
        ? null
        : dec(input.quantity);
    const places = (await this.currencies.requireActive(currency)).decimalPlaces;
    const total =
      quantity === null
        ? null
        : computeQuotationAmounts(
            [
              {
                quantity,
                unitPrice: rate.price,
                minimumCharge: rate.minimumCharge,
                discount: ZERO,
              },
            ],
            places,
          ).total;
    // The end of the quoted day (UTC); a card valid that day is valid all of it.
    const expiresAt = toDbDate(addDays(onDate, 1));

    const ref = newQuoteRef();
    await this.prisma.csQuote.create({
      data: {
        ref,
        apiClientId: client.id,
        rateCardId: rate.id,
        originLocationId: input.originId,
        destinationLocationId: input.destinationId,
        priceCategoryCode: category.code,
        mode,
        loadType,
        cargoType,
        currency,
        unit: rate.unit,
        quantity,
        pieces: volume?.pieces ?? null,
        lengthCm: volume?.dimensions.lengthCm ?? null,
        widthCm: volume?.dimensions.widthCm ?? null,
        heightCm: volume?.dimensions.heightCm ?? null,
        price: rate.price,
        minimumCharge: rate.minimumCharge,
        total,
        originScope: scoped.originScope,
        destinationScope: scoped.destinationScope,
        quotedOn: toDbDate(onDate),
        expiresAt,
      },
    });
    return {
      price: toDecimalString(rate.price),
      currency,
      unit: rate.unit,
      minimumCharge: toDecimalString(rate.minimumCharge),
      quantity: toDecimalStringOrNull(quantity),
      total: total === null ? null : total.toFixed(places),
      pieces: volume === null ? null : String(volume.pieces),
      dimensions:
        volume === null
          ? null
          : {
              lengthCm: toDecimalString(volume.dimensions.lengthCm),
              widthCm: toDecimalString(volume.dimensions.widthCm),
              heightCm: toDecimalString(volume.dimensions.heightCm),
            },
      volumeCbm: volume === null ? null : toDecimalString(volume.cbm),
      includes: [...CS_QUOTE_INCLUDES],
      mode,
      loadType,
      transitDays: rate.transitDays,
      validTo: fromDbDateOrNull(rate.validTo),
      scope: { origin: scoped.originScope, destination: scoped.destinationScope },
      source: { rateCardId: rate.id, approvedAt: rate.approvedAt.toISOString(), quotedOn: onDate },
      quoteRef: ref,
      quoteRefExpiresAt: expiresAt.toISOString(),
      validUntil: expiresAt.toISOString(),
      customerNote: null,
      bookable,
    };
  }

  /**
   * The cargo an approval's pricing inputs price (Codex F137-1): the booking takes its category's
   * cargo type and the load type priced, so the booking approved is the cargo staff priced.
   */
  async cargoOf(inputs: CsPriceInputs): Promise<{
    category: string;
    cargoType: CargoType;
    loadType: LoadType | null;
    unit: RateUnit;
  }> {
    const category = await this.masterData.requirePriceCategory(inputs.category, null);
    return {
      category: category.code,
      cargoType: category.cargoType,
      unit: category.defaultUnit,
      loadType: inputs.loadType ?? loadTypeOf(inputs.mode, category.cargoType),
    };
  }

  /**
   * The engine's price for an approval's inputs (plan 04a section 1), in `branchId` first: the one
   * approved FREIGHT card in the category's unit, with its total and the fingerprint approval sends
   * back; else `none` with why. Read outside any transaction: approval checks the card again under
   * its lock (requireSamePrice).
   */
  async priceFor(inputs: CsPriceInputs, branchId: string): Promise<ApprovalPrice> {
    const category = await this.masterData.requirePriceCategory(inputs.category, null);
    const places = (await this.currencies.requireActive(inputs.currency)).decimalPlaces;
    const loadType = inputs.loadType ?? loadTypeOf(inputs.mode, category.cargoType);
    const quantity = dec(inputs.quantity);
    const none = (reason: CsApprovalPriceDto['reason']): ApprovalPrice => ({
      dto: {
        state: 'none',
        reason,
        rateCardId: null,
        approvedAt: null,
        currency: inputs.currency,
        unit: null,
        unitPrice: null,
        minimumCharge: null,
        total: null,
        pricingFingerprint: null,
      },
      card: null,
    });
    const offers = await this.rates.systemScopedRates({
      branchId,
      onDate: todayIn('UTC'),
      currency: inputs.currency,
      originLocationId: inputs.originId,
      destinationLocationId: inputs.destinationId,
      mode: inputs.mode,
      loadType,
      cargoType: category.cargoType,
      priceCategoryCode: category.code,
      chargeTypeCode: FREIGHT,
    });
    if (offers.length === 0) return none('NO_RATE');
    const inUnit = offers.filter((o) => o.rate.unit === category.defaultUnit);
    if (inUnit.length === 0) return none('UNIT_MISMATCH');
    const [scoped, ...others] = inUnit;
    if (!scoped || others.length > 0) return none('AMBIGUOUS');
    const { rate } = scoped;
    if (!rate.approvedAt) return none('NO_RATE');
    const total = computeQuotationAmounts(
      [{ quantity, unitPrice: rate.price, minimumCharge: rate.minimumCharge, discount: ZERO }],
      places,
    ).total.toFixed(places);
    const card = {
      id: rate.id,
      approvedAt: rate.approvedAt,
      price: rate.price,
      minimumCharge: rate.minimumCharge,
    };
    return {
      dto: {
        state: 'priced',
        reason: null,
        rateCardId: rate.id,
        approvedAt: rate.approvedAt.toISOString(),
        currency: inputs.currency,
        unit: rate.unit,
        unitPrice: toDecimalString(rate.price),
        minimumCharge: toDecimalString(rate.minimumCharge),
        total,
        pricingFingerprint: pricingFingerprint(
          { ...inputs, loadType, category: category.code },
          card,
          total,
        ),
      },
      card,
    };
  }

  /**
   * The advisory check of a kept quote for staff (plan 04a section 1): the engine run again today
   * on the quote's own inputs, for the request's branch and quantity. Current when it picks the
   * same card, still approved and valid, in a currency still active, and gives the same total;
   * anything else is stale, with today's total when one card still prices it. Never a price of
   * record, and never a failure: the request it belongs to stays readable.
   */
  async recheck(
    quote: CsQuote,
    quantity: Prisma.Decimal,
    branchId: string | null,
  ): Promise<CsRequestPriceCheck> {
    const offers = await this.rates.systemScopedRates({
      branchId,
      onDate: todayIn('UTC'),
      currency: quote.currency,
      originLocationId: quote.originLocationId,
      destinationLocationId: quote.destinationLocationId,
      mode: quote.mode,
      loadType: quote.loadType,
      cargoType: quote.cargoType,
      priceCategoryCode: quote.priceCategoryCode,
      chargeTypeCode: FREIGHT,
    });
    // The quote's currency as recorded, active or not (Codex F131-1/2): a saved request stays
    // readable; a currency no longer offered only makes the quote stale.
    const currency = await this.currencies.requireRecorded(quote.currency);
    const inUnit = currency.isActive ? offers.filter((o) => o.rate.unit === quote.unit) : [];
    const card = inUnit.length === 1 ? inUnit[0]?.rate : undefined;
    const places = currency.decimalPlaces;
    const totalNow = card
      ? computeQuotationAmounts(
          [
            {
              quantity,
              unitPrice: card.price,
              minimumCharge: card.minimumCharge,
              discount: ZERO,
            },
          ],
          places,
        ).total
      : null;
    const same =
      card !== undefined &&
      card.id === quote.rateCardId &&
      card.approvedAt !== null &&
      totalNow !== null &&
      quote.total !== null &&
      totalNow.eq(quote.total);
    return {
      state: same ? 'current' : 'stale',
      rateCardId: quote.rateCardId,
      approvedAt: card?.id === quote.rateCardId ? (card.approvedAt?.toISOString() ?? null) : null,
      currency: quote.currency,
      unitPrice: toDecimalString(quote.price),
      quotedTotal: quote.total === null ? null : quote.total.toFixed(places),
      totalNow: totalNow === null ? null : totalNow.toFixed(places),
      mode: quote.mode,
      loadType: quote.loadType,
    };
  }
}

/** A price for an approval, and the card it comes from (null when there is no approved price). */
export interface ApprovalPrice {
  dto: CsApprovalPriceDto;
  card: {
    id: string;
    approvedAt: Date;
    price: Prisma.Decimal;
    minimumCharge: Prisma.Decimal;
  } | null;
}

/**
 * SHA-256 of an approval's pricing inputs, the card (id and approval time) and the total (plan 04a
 * section 1): any change to one of them is another fingerprint. The quantity is normalised, so 2
 * and 2.0 are the same input.
 */
export function pricingFingerprint(
  inputs: CsPriceInputs & { loadType: LoadType | null },
  card: { id: string; approvedAt: Date },
  total: string,
): string {
  const parts = [
    inputs.originId,
    inputs.destinationId,
    inputs.category,
    dec(inputs.quantity).toString(),
    inputs.mode,
    inputs.loadType ?? '',
    inputs.currency,
    card.id,
    card.approvedAt.toISOString(),
    total,
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
