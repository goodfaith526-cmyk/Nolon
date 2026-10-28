import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ExpectedMarginDto,
  RateCardCostDto,
  RateCardCostInput,
  RateCostComponent,
} from '@nolon/shared';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import { changedFields } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { requireBranchMemberInTx } from '../auth/branch-access.js';
import { branchScope } from '../auth/branch-scope.js';
import { todayIn } from '../common/dates.js';
import { type Decimal, dec } from '../common/money.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { RateCard, RateCardCost } from '../generated/prisma/client.js';
import { PartnerContractsService } from '../partners/partner-contracts.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type MarginCommission, computeExpectedMargin } from './expected-margin.js';
import { RatesService } from './rates.service.js';

/** The fields the card's audit log shows for a cost, as `cost.<component>.<field>`. */
const AUDITED_FIELDS = [
  'status',
  'amount',
  'currency',
  'unit',
  'unitsPerCostUnit',
  'note',
] as const;

/**
 * A rate card's reference costs and expected margin (business model plan 6.1). Planning figures
 * only: nothing here posts, accrues or feeds a financial report. Kept apart from the card itself
 * (rate_costs, not rates) so Sales and Operations see a price without its cost and margin; read
 * and written for the cards of the user's branches (AGENTS.md rule 2).
 */
@Injectable()
export class RateCostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RatesService,
    private readonly currencies: CurrenciesService,
    private readonly fxRates: FxRatesService,
    private readonly contracts: PartnerContractsService,
  ) {}

  async list(user: AuthUser, rateId: string): Promise<RateCardCostDto[]> {
    await this.findScoped(user, rateId);
    const costs = await this.prisma.rateCardCost.findMany({
      where: { rateCardId: rateId },
      orderBy: { component: 'asc' },
    });
    return costs.map(toDto);
  }

  /**
   * Enters one component, or marks it not applicable. Any card but a cancelled one: the costs are
   * a reference beside the price, not part of it, so an approved card's costs can be kept up to
   * date. Under the card's row lock, so two edits of a card's costs queue and log what they changed.
   */
  async put(
    user: AuthUser,
    rateId: string,
    component: RateCostComponent,
    input: RateCardCostInput,
  ): Promise<RateCardCostDto[]> {
    await this.prisma.$transaction(async (tx) => {
      const scoped = await this.findScoped(user, rateId);
      await requireBranchMemberInTx(tx, user, scoped.branchId);
      await tx.$queryRaw`SELECT 1 FROM "rate_cards" WHERE "id" = ${rateId}::uuid FOR NO KEY UPDATE`;
      const rate = await tx.rateCard.findUniqueOrThrow({ where: { id: rateId } });
      if (rate.status === 'CANCELLED') {
        throw new ConflictException('A cancelled rate card keeps its costs as they were');
      }
      const before = await tx.rateCardCost.findUnique({
        where: { rateCardId_component: { rateCardId: rateId, component } },
      });
      const entered = input.status === 'ENTERED';
      if (entered && input.currency !== before?.currency) {
        await this.currencies.requireActiveInTx(tx, input.currency);
      }
      const data = {
        status: input.status,
        amount: entered ? dec(input.amount) : null,
        currency: entered ? input.currency : null,
        unit: entered ? input.unit : null,
        unitsPerCostUnit: entered && input.unitsPerCostUnit ? dec(input.unitsPerCostUnit) : null,
        note: input.note ?? null,
        updatedById: user.id,
      };
      const after = await tx.rateCardCost.upsert({
        where: { rateCardId_component: { rateCardId: rateId, component } },
        create: { ...data, rateCardId: rateId, component },
        update: data,
      });
      const changes = changedFields(before, after, AUDITED_FIELDS);
      await this.rates.logCostsInTx(
        tx,
        user,
        rate,
        changes.map((c) => ({ ...c, field: `cost.${component}.${c.field}` })),
      );
    });
    return this.list(user, rateId);
  }

  /**
   * The card's expected margin today (its branch's day), for one unit or a reference quantity,
   * with the commission of `outletId` (an active sales outlet of the user's branches) or, without
   * one, incomplete until an outlet is chosen.
   */
  async margin(
    user: AuthUser,
    rateId: string,
    query: { outletId?: string; quantity?: string },
  ): Promise<ExpectedMarginDto> {
    const rate = await this.findScoped(user, rateId);
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: rate.branchId } });
    const asOf = todayIn(branch.timezone);
    const costs = await this.prisma.rateCardCost.findMany({ where: { rateCardId: rateId } });
    const commission: MarginCommission = query.outletId
      ? await this.contracts.commissionFor(user, query.outletId, rate.priceCategoryCode, asOf)
      : { kind: 'NO_OUTLET' };
    const currencies = new Set<string>([rate.currency]);
    for (const c of costs) if (c.currency) currencies.add(c.currency);
    if (commission.kind === 'CONTRACT' && commission.contract.currency) {
      currencies.add(commission.contract.currency);
    }
    const rates = new Map<string, Decimal | null>();
    for (const currency of currencies) {
      const found = await this.fxRates.lookup(currency, asOf);
      rates.set(currency, found ? dec(found.rate) : null);
    }
    const { decimalPlaces } = await this.currencies.requireRecorded(rate.currency);
    const quantity = query.quantity ? dec(query.quantity) : null;
    const result = computeExpectedMargin({
      card: {
        unit: rate.unit,
        price: rate.price,
        minimumCharge: rate.minimumCharge,
        currency: rate.currency,
      },
      costs,
      commission,
      quantity,
      fxRate: (currency) => rates.get(currency) ?? null,
      decimalPlaces,
    });
    return {
      rateCardId: rate.id,
      currency: rate.currency,
      quantity: quantity?.toFixed() ?? null,
      price: result.price.toFixed(),
      lines: result.lines.map((l) => ({
        component: l.component,
        amount: l.amount?.toFixed() ?? null,
        notApplicable: l.notApplicable,
        gap: l.gap,
      })),
      expectedMargin: result.expectedMargin?.toFixed() ?? null,
      incomplete: result.missing.length > 0,
      missing: result.missing,
      asOf,
    };
  }

  /** A card of the user's branches (narrowed to rate_costs by the guard); 404 otherwise. */
  private async findScoped(user: AuthUser, id: string): Promise<RateCard> {
    const rate = await this.prisma.rateCard.findFirst({ where: { id, ...branchScope(user) } });
    if (!rate) throw new NotFoundException('Rate not found');
    return rate;
  }
}

function toDto(c: RateCardCost): RateCardCostDto {
  return {
    component: c.component,
    status: c.status,
    amount: c.amount?.toFixed() ?? null,
    currency: c.currency,
    unit: c.unit,
    unitsPerCostUnit: c.unitsPerCostUnit?.toFixed() ?? null,
    note: c.note,
    updatedAt: c.updatedAt.toISOString(),
  };
}
