import { HttpStatus, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  COMMISSION_ROLES,
  type CommissionEvent,
  type CommissionHoldCode,
  type CommissionRole,
  type ManualCommissionInput,
  type PartnerCommissionsDto,
} from '@nolon/shared';
import { AutoJournalService } from '../accounting/auto-journal.service.js';
import { FxRatesService } from '../accounting/fx-rates.service.js';
import { toUsd } from '../accounting/journal-math.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope, canAccessBranch } from '../auth/branch-scope.js';
import { InvoicesService } from '../billing/invoices.service.js';
import { unitQuantity } from '../billing/invoice-suggestion.js';
import { todayIn } from '../common/dates.js';
import { type Decimal, ZERO, dec, roundMoney } from '../common/money.js';
import { codedRefusal } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { CommissionAccrual, PartnerContract, Prisma } from '../generated/prisma/client.js';
import { PartnerContractsService } from '../partners/partner-contracts.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CommissionTriggers,
  type CommissionSyncHandler,
  type ShipmentCommissionFacts,
} from '../shipments/commission-triggers.registry.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { PodService } from '../transport/pod.service.js';
import {
  type CommissionInvoice,
  type SlotTarget,
  ZERO_TARGET,
  commissionLines,
  fixedTarget,
  lineRate,
  percentTargets,
} from './commission-math.js';

type Tx = Prisma.TransactionClient;

/** The rows a page shows at most. */
const ROW_LIMIT = 200;

/** Why a slot's commission is not computed now, kept on the shipment (plan 07, 4.5). */
interface Hold {
  hold: CommissionHoldCode;
  detail: string;
}

/** What a slot should hold now, per currency, and the contract it follows (null: none). */
interface Targets {
  targets: Map<string, SlotTarget>;
  contractId: string | null;
}

/** What the sync reads once per shipment, as the slots need it. */
class ShipmentFacts {
  private invoicesRead: Promise<(CommissionInvoice & { invoiceDate: string })[]> | null = null;
  private deliveredRead: Promise<Date | null> | null = null;

  constructor(
    readonly shipmentId: string,
    readonly facts: ShipmentCommissionFacts,
    private readonly read: {
      invoices: () => Promise<(CommissionInvoice & { invoiceDate: string })[]>;
      delivered: () => Promise<Date | null>;
    },
  ) {}

  invoices() {
    this.invoicesRead ??= this.read.invoices();
    return this.invoicesRead;
  }

  /** The day each event happened on in the shipment's branch, for the events that happened. */
  async eventDays(): Promise<Partial<Record<CommissionEvent, string>>> {
    this.deliveredRead ??= this.read.delivered();
    const [invoices, delivered] = await Promise.all([this.invoices(), this.deliveredRead]);
    const day = (at: Date) => todayIn(this.facts.timezone, at);
    const first = invoices[0];
    return {
      ...(first ? { INVOICED: first.invoiceDate } : {}),
      ...(this.facts.departedAt ? { DEPARTED: day(this.facts.departedAt) } : {}),
      ...(delivered ? { DELIVERED: day(delivered) } : {}),
    };
  }

  /** The category every line shares; null for lines of several (or a line without one). */
  get category(): string | null {
    const [first, ...rest] = this.facts.categories;
    return first && rest.every((c) => c === first) ? first : null;
  }
}

/**
 * Partner commissions (plan 07, rule 16): a sub-ledger of each partner's commission on each
 * shipment, kept equal to what the partner's contract earns on the shipment as it is now, by
 * difference, in its currency and in USD. Every write that can change it calls `syncShipmentInTx`
 * inside its own transaction (CommissionTriggers); rows and entries are only ever added.
 */
@Injectable()
export class CommissionAccrualService implements CommissionSyncHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly triggers: CommissionTriggers,
    private readonly shipments: ShipmentsService,
    private readonly invoices: InvoicesService,
    private readonly pods: PodService,
    private readonly contracts: PartnerContractsService,
    private readonly autoJournal: AutoJournalService,
    private readonly fxRates: FxRatesService,
    private readonly currencies: CurrenciesService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.triggers.register(this);
  }

  async syncShipmentInTx(tx: Tx, user: AuthUser, shipmentId: string, date?: string) {
    await this.triggers.lockInTx(tx, shipmentId);
    const facts = await this.shipments.commissionFactsInTx(tx, shipmentId);
    const shipment = new ShipmentFacts(shipmentId, facts, {
      invoices: () => this.invoices.commissionInvoicesInTx(tx, shipmentId),
      delivered: () => this.pods.fullDeliveryAtInTx(tx, shipmentId),
    });
    const entryDate = date ?? todayIn(facts.timezone);
    const rows = await tx.commissionAccrual.findMany({
      where: { shipmentId, kind: { not: 'MANUAL' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const role of COMMISSION_ROLES) {
      const partnerId = facts.partners[role];
      const ofRole = rows.filter((r) => r.role === role);
      // A partner taken off the shipment (or replaced) gives back all it accrued.
      for (const former of new Set(ofRole.map((r) => r.partnerId))) {
        if (former === partnerId) continue;
        const own = ofRole.filter((r) => r.partnerId === former);
        await this.settle(tx, user, shipment, entryDate, former, role, own, {
          targets: new Map(),
          contractId: null,
        });
      }
      if (!partnerId) {
        await tx.commissionHold.deleteMany({ where: { shipmentId, role } });
        continue;
      }
      const own = ofRole.filter((r) => r.partnerId === partnerId);
      const outcome =
        facts.status === 'CANCELLED'
          ? { targets: new Map<string, SlotTarget>(), contractId: null }
          : await this.targets(tx, shipment, partnerId, own);
      const held =
        'hold' in outcome
          ? outcome
          : await this.settle(tx, user, shipment, entryDate, partnerId, role, own, outcome);
      if (held) {
        await tx.commissionHold.upsert({
          where: { shipmentId_role: { shipmentId, role } },
          create: { shipmentId, role, partnerId, code: held.hold, detail: held.detail },
          update: { partnerId, code: held.hold, detail: held.detail },
        });
      } else {
        await tx.commissionHold.deleteMany({ where: { shipmentId, role } });
      }
    }
  }

  /**
   * What the partner's contract earns on the shipment now, per currency (4.2). The contract is the
   * slot's own once it accrued; before that, the approved contract valid on the day of the event it
   * names, for the shipment's category. Nothing is earned before its event, nor without a contract.
   */
  private async targets(
    tx: Tx,
    shipment: ShipmentFacts,
    partnerId: string,
    rows: readonly CommissionAccrual[],
  ): Promise<Targets | Hold> {
    const days = await shipment.eventDays();
    const kept = rows.find((r) => r.contractId)?.contractId;
    let contract: PartnerContract | null;
    if (kept) {
      contract = await this.contracts.contractInTx(tx, kept);
    } else {
      const found = new Map<string, PartnerContract>();
      let mixed = false;
      for (const [event, day] of Object.entries(days)) {
        const { contract: c, anyOnDay } = await this.contracts.commissionContractInTx(
          tx,
          partnerId,
          shipment.category,
          day,
        );
        if (c?.accrualEvent === event) found.set(c.id, c);
        else if (!c && anyOnDay && shipment.category === null) mixed = true;
      }
      if (found.size > 1) {
        return {
          hold: 'COMMISSION_CONTRACT_AMBIGUOUS',
          detail: [...found.values()].map((c) => c.accrualEvent).join(', '),
        };
      }
      contract = [...found.values()][0] ?? null;
      if (!contract && mixed) {
        return {
          hold: 'COMMISSION_MIXED_CATEGORIES',
          detail: 'No approved contract for every category',
        };
      }
    }
    const none = { targets: new Map<string, SlotTarget>(), contractId: contract?.id ?? null };
    if (!contract) return none;
    const eventDay = days[contract.accrualEvent];
    if (!eventDay) return none;
    if (contract.basis === 'PERCENT_OF_PRICE') {
      const invoices = await shipment.invoices();
      const places = await this.decimals(invoices.map((i) => i.currency));
      return {
        targets: percentTargets(invoices, contract.value, (c) => places.get(c) ?? 2),
        contractId: contract.id,
      };
    }
    const currency = contract.currency;
    const unit = contract.unit;
    if (!currency || !unit) throw new Error(`Contract ${contract.id} has no unit or currency`);
    const quantity = unitQuantity(unit, shipment.facts.items, null, shipment.facts.cargoType);
    if (!quantity) return { hold: 'COMMISSION_UNIT_UNKNOWN', detail: unit };
    // The slot's rate, kept from its first accrual (4.2), else the table's on the event's day.
    const saved = rows.find((r) => r.currency === currency && r.fxRate)?.fxRate;
    const rate = saved ?? (await this.fxRates.lookup(currency, eventDay))?.rate;
    if (!rate) return { hold: 'COMMISSION_NO_FX_RATE', detail: `${currency} ${eventDay}` };
    const places = await this.decimals([currency]);
    return {
      targets: new Map([
        [
          currency,
          fixedTarget(quantity, contract.value, currency, places.get(currency) ?? 2, dec(rate)),
        ],
      ]),
      contractId: contract.id,
    };
  }

  /**
   * Posts what moves each of the slot's currencies from what its rows hold to its target, one row
   * and one rule 16 entry per currency that changed. Returns a hold when a change rounds to
   * 0.00 USD (it waits for the next change).
   */
  private async settle(
    tx: Tx,
    user: AuthUser,
    shipment: ShipmentFacts,
    entryDate: string,
    partnerId: string,
    role: CommissionRole,
    rows: readonly CommissionAccrual[],
    { targets, contractId }: Targets,
  ): Promise<Hold | null> {
    const { shipmentId, facts } = shipment;
    const currencies = new Set([...targets.keys(), ...rows.map((r) => r.currency)]);
    let partner: Awaited<ReturnType<PartnerContractsService['partnerInTx']>> | null = null;
    let held: Hold | null = null;
    for (const currency of currencies) {
      const own = rows.filter((r) => r.currency === currency);
      const target = targets.get(currency) ?? ZERO_TARGET;
      const amount = target.amount.minus(sum(own.map((r) => r.amount)));
      const amountUsd = target.amountUsd.minus(sum(own.map((r) => r.amountUsd)));
      if (amount.isZero() && amountUsd.isZero()) continue;
      const fallback = own.at(-1)?.fxRate ?? dec(1);
      const pairs = commissionLines(
        currency,
        lineRate(target, amount, amountUsd, fallback),
        amount,
        amountUsd,
      );
      if (!pairs) {
        held = { hold: 'COMMISSION_TOO_SMALL', detail: `${amount.toFixed()} ${currency}` };
        continue;
      }
      partner ??= await this.contracts.partnerInTx(tx, partnerId);
      const entry = await this.autoJournal.commissionChanged(
        tx,
        {
          shipmentId,
          shipmentNumber: facts.number,
          branchId: facts.branchId,
          entryDate,
          partnerNumber: partner.number,
          supplierId: partner.supplierId,
          pairs,
          description: `Partner commission: ${partner.name} (${role}) on ${facts.number}`,
        },
        user.id,
      );
      await tx.commissionAccrual.create({
        data: {
          shipmentId,
          partnerId,
          contractId: contractId ?? own[0]?.contractId ?? null,
          role,
          kind:
            own.length === 0
              ? 'ACCRUAL'
              : target.amount.isZero() && target.amountUsd.isZero()
                ? 'REVERSAL'
                : 'ADJUSTMENT',
          branchId: facts.branchId,
          currency,
          base: target.base,
          quantity: target.quantity,
          fxRate: target.fxRate,
          amount,
          amountUsd,
          entryId: entry.id,
          createdById: user.id,
        },
      });
    }
    return held;
  }

  /**
   * Computes the shipment's commissions again (plan 07, 4.5: after an exchange rate or a contract
   * was added). Same sync as every write's. 404 outside the user's branches (the route's permission
   * narrows them). Returns the shipment's holds that are left.
   */
  async recompute(user: AuthUser, shipmentId: string): Promise<{ holds: number }> {
    await this.requireShipment(user, shipmentId);
    await this.prisma.$transaction(async (tx) => {
      await this.shipments.lockForChildWrite(tx, shipmentId, { exclusive: true });
      await this.syncShipmentInTx(tx, user, shipmentId);
    });
    return { holds: await this.prisma.commissionHold.count({ where: { shipmentId } }) };
  }

  /**
   * A manual adjustment (plan 07, 4.6): a MANUAL row and its rule 16 entry, at today's rate, with
   * the reason, on a shipment the partner holds `role` on now. Outside the sync's sums, so the next
   * sync keeps it. Recorded in the audit log under the partner.
   */
  async adjust(
    user: AuthUser,
    partnerId: string,
    input: ManualCommissionInput,
  ): Promise<PartnerCommissionsDto> {
    await this.requireShipment(user, input.shipmentId);
    const currency = await this.currencies.requireActive(input.currency);
    const amount = dec(input.amount);
    if (amount.isZero() || !roundMoney(amount, currency.decimalPlaces).eq(amount)) {
      throw codedRefusal(
        HttpStatus.BAD_REQUEST,
        'COMMISSION_AMOUNT_INVALID',
        `The amount is not zero and has at most ${currency.decimalPlaces} decimals`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await this.shipments.lockForChildWrite(tx, input.shipmentId, { exclusive: true });
      await this.triggers.lockInTx(tx, input.shipmentId);
      const facts = await this.shipments.commissionFactsInTx(tx, input.shipmentId);
      if (facts.partners[input.role] !== partnerId) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'COMMISSION_NOT_PARTNER',
          `The partner is not the shipment's ${input.role.toLowerCase().replace('_', ' ')}`,
        );
      }
      const today = todayIn(facts.timezone);
      const found = await this.fxRates.lookup(currency.code, today);
      if (!found) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'COMMISSION_NO_FX_RATE',
          `No exchange rate for ${currency.code} on or before ${today}: add one first`,
        );
      }
      const rate = dec(found.rate);
      const usd = toUsd(amount.abs(), rate, currency.code);
      const amountUsd = amount.isNegative() ? usd.negated() : usd;
      const pairs = commissionLines(currency.code, rate, amount, amountUsd);
      if (!pairs) {
        throw codedRefusal(
          HttpStatus.BAD_REQUEST,
          'COMMISSION_AMOUNT_INVALID',
          'The amount rounds to 0.00 USD at this exchange rate',
        );
      }
      const partner = await this.contracts.partnerInTx(tx, partnerId);
      const entry = await this.autoJournal.commissionChanged(
        tx,
        {
          shipmentId: input.shipmentId,
          shipmentNumber: facts.number,
          branchId: facts.branchId,
          entryDate: today,
          partnerNumber: partner.number,
          supplierId: partner.supplierId,
          pairs,
          description: `Partner commission adjusted: ${partner.name} (${input.role}) on ${facts.number}: ${input.reason}`,
        },
        user.id,
      );
      await tx.commissionAccrual.create({
        data: {
          shipmentId: input.shipmentId,
          partnerId,
          role: input.role,
          kind: 'MANUAL',
          branchId: facts.branchId,
          currency: currency.code,
          fxRate: rate,
          amount,
          amountUsd,
          entryId: entry.id,
          reason: input.reason,
          createdById: user.id,
        },
      });
      await this.audit.record(tx, user, {
        branchId: facts.branchId,
        entity: 'PARTNER',
        entityId: partner.id,
        reference: `${partner.number} ${partner.name}`,
        action: 'CREATED',
        changes: [
          {
            field: 'commission.manual',
            before: null,
            after: `${facts.number} ${input.role} ${amount.toFixed()} ${currency.code}: ${input.reason}`,
          },
        ],
      });
    });
    return this.forPartner(user, partnerId);
  }

  /**
   * A partner's commissions in the user's branches (the route's permission narrows them; rows are
   * of the shipment's branch, which can differ from the partner's): what is open per branch and
   * currency, the latest rows and the holds. 404 for a partner the user sees neither in its own
   * branch nor through a row.
   */
  async forPartner(user: AuthUser, partnerId: string): Promise<PartnerCommissionsDto> {
    const scope = branchScope(user);
    const [partner, seen] = await Promise.all([
      this.prisma.partner.findFirst({ where: { id: partnerId, ...scope }, select: { id: true } }),
      this.prisma.commissionAccrual.findFirst({
        where: { partnerId, ...scope },
        select: { id: true },
      }),
    ]);
    if (!partner && !seen) throw new NotFoundException('Partner not found');
    const [open, rows, holds] = await Promise.all([
      this.prisma.commissionAccrual.groupBy({
        by: ['branchId', 'currency'],
        where: { partnerId, statementId: null, ...scope },
        _sum: { amount: true, amountUsd: true },
        orderBy: [{ branchId: 'asc' }, { currency: 'asc' }],
      }),
      this.prisma.commissionAccrual.findMany({
        where: { partnerId, ...scope },
        include: {
          shipment: { select: { number: true } },
          branch: { select: { code: true } },
          entry: { select: { number: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ROW_LIMIT,
      }),
      this.prisma.commissionHold.findMany({
        where: { partnerId, shipment: scope },
        include: { shipment: { select: { number: true, branchId: true } } },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);
    const codes = new Map(
      (
        await this.prisma.branch.findMany({
          where: { id: { in: open.map((o) => o.branchId) } },
          select: { id: true, code: true },
        })
      ).map((b) => [b.id, b.code]),
    );
    const adjusts = (branchId: string) =>
      user.access.has('partner_commissions:approve', branchId) && canAccessBranch(user, branchId);
    return {
      partnerId,
      balances: open.map((o) => ({
        branchId: o.branchId,
        branchCode: codes.get(o.branchId) ?? '',
        currency: o.currency,
        open: (o._sum.amount ?? ZERO).toFixed(),
        openUsd: (o._sum.amountUsd ?? ZERO).toFixed(),
      })),
      rows: rows.map((r) => ({
        id: r.id,
        shipmentId: r.shipmentId,
        shipmentNumber: r.shipment.number,
        branchCode: r.branch.code,
        role: r.role,
        kind: r.kind,
        currency: r.currency,
        amount: r.amount.toFixed(),
        amountUsd: r.amountUsd.toFixed(),
        base: r.base?.toFixed() ?? null,
        quantity: r.quantity?.toFixed() ?? null,
        entryNumber: r.entry.number,
        statementId: r.statementId,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
      holds: holds.map((h) => ({
        shipmentId: h.shipmentId,
        shipmentNumber: h.shipment.number,
        role: h.role,
        code: h.code as CommissionHoldCode,
        detail: h.detail,
        updatedAt: h.updatedAt.toISOString(),
        canRecompute: adjusts(h.shipment.branchId),
      })),
      canAdjust: user.allowedBranchIds.some(adjusts),
    };
  }

  /** The shipment, in the user's branches (its own branch: rows and entries are its). 404 else. */
  private async requireShipment(user: AuthUser, shipmentId: string): Promise<void> {
    const found = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, ...branchScope(user) },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Shipment not found');
  }

  private async decimals(codes: readonly string[]): Promise<Map<string, number>> {
    const places = new Map<string, number>();
    for (const code of new Set(codes)) {
      places.set(code, (await this.currencies.requireRecorded(code)).decimalPlaces);
    }
    return places;
  }
}

function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), ZERO);
}
