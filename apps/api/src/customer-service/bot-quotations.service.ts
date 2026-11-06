import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CsQuotationSaved } from '@nolon/shared';
import { fromDbDate, fromDbDateOrNull } from '../common/dates.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { CustomersService } from '../customers/customers.service.js';
import type { Prisma, Quotation } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import type { BookingRequestCaller } from './booking-request.guard.js';
import { currentKey } from './booking-requests.service.js';
import { CustomerIdentityAuth } from './customer-identity-auth.js';
import type { IdentityChannel } from './customer-identity.contract.js';
import { CustomerTokensService } from './customer-tokens.service.js';

/** The sender proven by a signed channel identity (plan 08), as its context names it. */
export interface QuoteSaveProof {
  channel: IdentityChannel;
  subjectId: string;
}

function coded(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ message, code, statusCode: status }, status);
}

/** What every quote of one quotation shares: the quotation's header, branch and currency. */
function headerKey(q: {
  originLocationId: string;
  destinationLocationId: string;
  mode: string;
  loadType: string | null;
  cargoType: string;
  currency: string;
  rateCard: { branchId: string };
}): string {
  return JSON.stringify([
    q.originLocationId,
    q.destinationLocationId,
    q.mode,
    q.loadType,
    q.cargoType,
    q.currency,
    q.rateCard.branchId,
  ]);
}

function saved(quotation: Quotation, places: number, created: boolean): CsQuotationSaved {
  return {
    quotationId: quotation.id,
    number: quotation.number,
    status: quotation.status,
    currency: quotation.currency,
    total: quotation.total.toFixed(places),
    validUntil: fromDbDate(quotation.validUntil),
    created,
  };
}

/**
 * Owner, 2026-11-05: every price the bot gives a customer reaches Quotations. The bot names the
 * quotes of one answer (their quoteRefs, its own key's, unexpired, each with a total) and NOLON
 * saves them as one SENT quotation (source BOT_QUOTE) for the customer it proves: a customer token's
 * own, or the central customer of the profile its signed channel identity belongs to. The key alone
 * is no proof. The quotation is in the branch whose cards priced the quotes, one the key still
 * serves. The same quotes again answer the same quotation (created false); nothing else is written.
 */
@Injectable()
export class BotQuotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotations: QuotationsService,
    private readonly customers: CustomersService,
    private readonly identityAuth: CustomerIdentityAuth,
    private readonly tokens: CustomerTokensService,
    private readonly currencies: CurrenciesService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async save(
    caller: BookingRequestCaller,
    proof: QuoteSaveProof | null,
    quoteRefs: readonly string[],
  ): Promise<{ created: boolean; body: CsQuotationSaved }> {
    if (!this.env.CS_QUOTE_SAVE_ENABLED) {
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        'QUOTE_SAVE_UNAVAILABLE',
        'Saving quotes is not available yet',
      );
    }
    if (caller.kind === 'key' && !proof) {
      throw coded(
        HttpStatus.FORBIDDEN,
        'OWNER_PROOF_REQUIRED',
        'Saving a quote needs the customer token or a signed channel identity of the sender',
      );
    }
    const refs = [...new Set(quoteRefs)].sort();
    if (refs.length !== quoteRefs.length) {
      throw coded(HttpStatus.BAD_REQUEST, 'DUPLICATE_QUOTE', 'A quoteRef is named twice');
    }
    const apiClientId = caller.client.id;
    const result = await this.prisma.$transaction(async (tx) => {
      const { branchIds } = await currentKey(tx, caller);
      // The quotes row-locked in one order: the same quotes saved twice at once wait, and the
      // second answers the first's quotation.
      await tx.$queryRaw`
        SELECT 1 FROM "cs_quotes"
        WHERE "ref" = ANY(${refs}::text[]) AND "api_client_id" = ${apiClientId}::uuid
        ORDER BY "ref" FOR UPDATE`;
      const quotes = await tx.csQuote.findMany({
        where: { ref: { in: refs }, apiClientId },
        include: {
          rateCard: { select: { branchId: true, chargeTypeCode: true, validTo: true } },
          saved: { select: { quotationId: true } },
        },
        orderBy: { ref: 'asc' },
      });
      if (quotes.length !== refs.length) {
        throw coded(HttpStatus.NOT_FOUND, 'QUOTE_NOT_FOUND', 'No quote of this key has this ref');
      }
      const customerId = await this.customerOf(tx, caller, proof);
      // Kept in the caller's order (the answer's items), for the quotation's lines.
      const ordered = quoteRefs.map((ref) => quotes.find((q) => q.ref === ref)!);
      const savedIn = new Set(quotes.map((q) => q.saved?.quotationId ?? null));
      const first = ordered[0]!;
      const savedId = first.saved?.quotationId ?? null;
      if (savedIn.size === 1 && savedId !== null) {
        const quotation = await tx.quotation.findUniqueOrThrow({ where: { id: savedId } });
        // Codex F203-1: a replay answers only in a branch the key still serves, as a new save.
        if (!branchIds.includes(quotation.branchId)) throw branchNotServed();
        const sameSet =
          (await tx.csQuoteSave.count({ where: { quotationId: savedId } })) === refs.length;
        if (quotation.customerId !== customerId || !sameSet) throw alreadySaved();
        return { created: false, quotation };
      }
      if (savedIn.size > 1) throw alreadySaved();
      const now = new Date();
      if (quotes.some((q) => q.expiresAt <= now)) {
        throw coded(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'QUOTE_EXPIRED',
          'A quote has expired: quote again, then save',
        );
      }
      if (quotes.some((q) => q.total === null || q.quantity === null)) {
        throw coded(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'QUOTE_WITHOUT_TOTAL',
          'A quote has no quantity, so no total: quote with the quantity, then save',
        );
      }
      if (new Set(quotes.map(headerKey)).size > 1) {
        throw coded(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'QUOTES_DIFFER',
          'The quotes differ in route, mode, load, cargo, currency or branch: save them apart',
        );
      }
      const branchId = first.rateCard.branchId;
      if (!branchIds.includes(branchId)) throw branchNotServed();
      const key = await tx.apiClient.findUniqueOrThrow({
        where: { id: apiClientId },
        select: { createdById: true },
      });
      const ends = quotes.flatMap((q) => fromDbDateOrNull(q.rateCard.validTo) ?? []).sort();
      const quotation = await this.quotations.insertFromBotQuotesInTx(tx, {
        apiClientId,
        createdById: key.createdById,
        branchId,
        customerId,
        currency: first.currency,
        header: {
          originLocationId: first.originLocationId,
          destinationLocationId: first.destinationLocationId,
          mode: first.mode,
          loadType: first.loadType,
          cargoType: first.cargoType,
        },
        cardsValidTo: ends[0] ?? null,
        lines: ordered.map((q) => ({
          rateCardId: q.rateCardId,
          chargeTypeCode: q.rateCard.chargeTypeCode,
          unit: q.unit,
          quantity: q.quantity!,
          unitPrice: q.price,
          minimumCharge: q.minimumCharge,
          lineTotal: q.total!,
          priceCategoryCode: q.priceCategoryCode,
        })),
      });
      await tx.csQuoteSave.createMany({
        data: refs.map((quoteRef) => ({ quoteRef, quotationId: quotation.id })),
      });
      return { created: true, quotation };
    });
    if (caller.kind === 'customer') {
      await this.tokens.record(
        apiClientId,
        caller.token.tokenId,
        caller.token.customerId,
        'OK',
        'POST /cs/quotations',
      );
    }
    // As the quote answered it: in the currency's decimal places (300.00).
    const places = (await this.currencies.requireRecorded(result.quotation.currency)).decimalPlaces;
    return { created: result.created, body: saved(result.quotation, places, result.created) };
  }

  /**
   * The proven customer, active, share-locked for the write: a customer token's own, or the
   * central customer (plan 09d) of the profile the signed sender's channel identity belongs to.
   * An identity not known, blocked, with no profile, or a profile with no active customer yet is
   * 409 CUSTOMER_NOT_READY: the bot captures the customer first (customer-identity/1).
   */
  private async customerOf(
    tx: Prisma.TransactionClient,
    caller: BookingRequestCaller,
    proof: QuoteSaveProof | null,
  ): Promise<string> {
    if (caller.kind === 'customer') {
      await this.customers.lockActiveCustomerInTx(tx, caller.token.customerId);
      return caller.token.customerId;
    }
    const identity = proof
      ? await tx.customerChannelIdentity.findUnique({
          where: {
            companyId_channel_subjectId: {
              companyId: this.identityAuth.companyId,
              channel: proof.channel,
              subjectId: proof.subjectId,
            },
          },
          select: { profileId: true, blocked: true },
        })
      : null;
    const customerId =
      identity?.profileId && !identity.blocked
        ? await this.customers.activeProfileCustomerInTx(tx, identity.profileId)
        : null;
    if (!customerId) {
      throw coded(
        HttpStatus.CONFLICT,
        'CUSTOMER_NOT_READY',
        'This sender has no active customer file yet: capture the customer first',
      );
    }
    return customerId;
  }
}

function branchNotServed(): HttpException {
  return coded(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'BRANCH_NOT_SERVED',
    'The branch that priced these quotes is not one of this key',
  );
}

function alreadySaved(): HttpException {
  return coded(
    HttpStatus.CONFLICT,
    'QUOTE_ALREADY_SAVED',
    'A quote is already saved in another quotation',
  );
}
