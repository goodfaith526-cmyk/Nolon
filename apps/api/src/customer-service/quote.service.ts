import { randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CS_QUOTE_INCLUDES,
  type CsQuoteChoices,
  type CsQuoteDto,
  type CsQuoteRequest,
  type CurrencyCode,
  type LoadType,
  type ShippingMode,
  loadTypeOf,
} from '@nolon/shared';
import { addDays, fromDbDateOrNull, todayIn, toDbDate } from '../common/dates.js';
import { FailureLimiter, type LimitRule } from '../common/failure-limiter.js';
import { ZERO, dec, toDecimalString, toDecimalStringOrNull } from '../common/money.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeQuotationAmounts } from '../quotations/quotation-totals.js';
import { RatesService } from '../rates/rates.service.js';
import type { ApiClientAuth } from './api-client.guard.js';

/** Per key: 300 quotes in 15 minutes. Prices are public, but a key must not scrape them all. */
export const QUOTE_KEY_RULE: LimitRule = {
  maxFailures: 300,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

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

/**
 * The customer-service price for a route (R2, docs/plans/04 section 5), from NOLON's own engine:
 * the cards systemScopedRates offers (narrowest scope, category before general, every branch),
 * the FREIGHT charge only, and computeQuotationAmounts for the minimum and the rounding. Where
 * the cards differ on what the client left out, it is asked (QUOTE_AMBIGUOUS), never chosen for
 * it. Each answer is kept (cs_quotes) under a random `quoteRef` a booking request names later.
 */
@Injectable()
export class QuoteService {
  private readonly limiter = new FailureLimiter(QUOTE_KEY_RULE);

  constructor(
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataService,
    private readonly rates: RatesService,
    private readonly currencies: CurrenciesService,
  ) {}

  async quote(client: ApiClientAuth, input: CsQuoteRequest): Promise<CsQuoteDto> {
    if (this.limiter.isBlocked(client.id)) {
      throw new HttpException(
        { message: 'Too many quotes, try again later', code: 'TOO_MANY', statusCode: 429 },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.limiter.recordFailure(client.id);

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
      branchId: null,
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

    const quantity = input.quantity === undefined ? null : dec(input.quantity);
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
      includes: [...CS_QUOTE_INCLUDES],
      mode,
      loadType,
      transitDays: rate.transitDays,
      validTo: fromDbDateOrNull(rate.validTo),
      scope: { origin: scoped.originScope, destination: scoped.destinationScope },
      source: { rateCardId: rate.id, approvedAt: rate.approvedAt.toISOString(), quotedOn: onDate },
      quoteRef: ref,
      quoteRefExpiresAt: expiresAt.toISOString(),
      customerNote: null,
    };
  }
}
