import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user.js';
import { AuditService } from '../audit/audit.service.js';
import { todayIn } from '../common/dates.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PartnerRefsService } from '../partners/partner-refs.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Plan 18, 4 (build 18-2): a shipment's referral facts and the REFERRER commission slot derived
 * from them, whatever the order of goods receipt and payment.
 *
 * - `broughtByPartnerId`: the broker picked at the window receipt (or by staff, correcting).
 * - `firstForCustomerId`: this shipment holds its customer's first paid shipment. Taken at the
 *   approval of the shipment's first customer invoice, freed by its cancellation; unique, so one
 *   shipment per customer holds it.
 * - `referrerId`/`referrerReason`: the slot (`decide` below is its only rule).
 *
 * Lock order (F237-2, revised): the customer row is never locked or written here. Taking or
 * freeing a first takes the advisory lock `referral-first:<customer>` after the caller's own
 * shipment and invoice locks; nothing takes a shipment or invoice lock after it, and capture and
 * profile writes never take it.
 * The caller syncs the commissions afterwards (CommissionTriggers), in the same transaction.
 */
@Injectable()
export class ShipmentReferralsService {
  constructor(
    private readonly audit: AuditService,
    private readonly partnerRefs: PartnerRefsService,
  ) {}

  /**
   * At the approval of a customer invoice (InvoicesService.approveInTx, before its commission
   * sync): on the shipment's first approved invoice, the shipment takes its customer's first when
   * the customer has an active broker, no other shipment holds it, and the broker's expiry (if any)
   * allows the invoice date. The broker is kept on the slot even if staff change the customer's
   * broker later.
   */
  async invoiceApprovedInTx(
    tx: Tx,
    actor: AuthUser,
    shipmentId: string,
    invoiceId: string,
    invoiceDate: string,
  ): Promise<void> {
    const earlier = await tx.customerInvoice.count({
      where: { shipmentId, id: { not: invoiceId }, status: 'APPROVED' },
    });
    if (earlier > 0) return;
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: {
        number: true,
        branchId: true,
        customerId: true,
        branch: { select: { timezone: true } },
        customer: {
          select: {
            referredByPartnerId: true,
            referredAt: true,
            referredBy: { select: { referralWindowDays: true } },
          },
        },
      },
    });
    const { customer } = shipment;
    const brokerId = customer.referredByPartnerId;
    if (!brokerId || !customer.referredAt) return;
    const windowDays = customer.referredBy?.referralWindowDays ?? null;
    if (windowDays !== null) {
      const from = todayIn(shipment.branch.timezone, customer.referredAt);
      if (daysBetween(from, invoiceDate) > windowDays) return;
    }
    if (!(await this.partnerRefs.activeReferrerInTx(tx, brokerId))) return;
    await this.lockFirstInTx(tx, shipment.customerId);
    const holder = await tx.shipmentReferral.findUnique({
      where: { firstForCustomerId: shipment.customerId },
      select: { shipmentId: true },
    });
    if (holder) return;
    const before = await tx.shipmentReferral.findUnique({ where: { shipmentId } });
    await tx.shipmentReferral.upsert({
      where: { shipmentId },
      create: {
        shipmentId,
        firstForCustomerId: shipment.customerId,
        referrerId: brokerId,
        referrerReason: 'FIRST_SHIPMENT',
      },
      update: {
        firstForCustomerId: shipment.customerId,
        referrerId: brokerId,
        referrerReason: 'FIRST_SHIPMENT',
      },
    });
    await this.audit.record(tx, actor, {
      branchId: shipment.branchId,
      entity: 'SHIPMENT',
      entityId: shipmentId,
      reference: shipment.number,
      action: 'UPDATED',
      changes: [
        { field: 'referralFirstFor', before: null, after: shipment.customerId },
        ...slotChanges(before, { referrerId: brokerId, referrerReason: 'FIRST_SHIPMENT' }),
      ],
    });
  }

  /**
   * At the shipment's cancellation (after its own locks): a first it held is freed, so the next
   * shipment whose first invoice is approved takes it; the slot is decided again (the commission
   * sync then reverses whatever the cancelled shipment earned).
   */
  async cancelledInTx(tx: Tx, actor: AuthUser, shipmentId: string): Promise<void> {
    const row = await tx.shipmentReferral.findUnique({ where: { shipmentId } });
    if (!row) return;
    if (row.firstForCustomerId) await this.lockFirstInTx(tx, row.firstForCustomerId);
    await this.writeInTx(tx, actor, shipmentId, row, {
      broughtByPartnerId: row.broughtByPartnerId,
      firstForCustomerId: null,
    });
  }

  /**
   * Plan 18, 4.3: the broker who brought the goods in person (null: none), picked at the window
   * receipt or corrected by staff with a reason. The caller has checked the partner. Never
   * refuses for precedence: `decide` says who is paid. Whether anything changed.
   */
  async setBroughtByInTx(
    tx: Tx,
    actor: AuthUser,
    shipmentId: string,
    partnerId: string | null,
    reason: string | null,
  ): Promise<boolean> {
    const row = await tx.shipmentReferral.findUnique({ where: { shipmentId } });
    if ((row?.broughtByPartnerId ?? null) === partnerId) return false;
    await this.writeInTx(
      tx,
      actor,
      shipmentId,
      row,
      { broughtByPartnerId: partnerId, firstForCustomerId: row?.firstForCustomerId ?? null },
      reason,
    );
    return true;
  }

  /**
   * The window's check on a broker picked at receipt: an active referrer of the booking's branch
   * (the window user holds no partner permission). 400 on the field otherwise.
   */
  async requireWindowReferrerInTx(tx: Tx, partnerId: string, branchId: string): Promise<void> {
    await this.partnerRefs.requireBranchReferrerInTx(
      tx,
      partnerId,
      branchId,
      'broughtByReferrerId',
    );
  }

  private async writeInTx(
    tx: Tx,
    actor: AuthUser,
    shipmentId: string,
    before: ReferralRow | null,
    facts: { broughtByPartnerId: string | null; firstForCustomerId: string | null },
    reason: string | null = null,
  ): Promise<void> {
    const slot = decide({
      ...facts,
      firstReferrerId: facts.firstForCustomerId ? (before?.referrerId ?? null) : null,
    });
    await tx.shipmentReferral.upsert({
      where: { shipmentId },
      create: { shipmentId, ...facts, ...slot },
      update: { ...facts, ...slot },
    });
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { number: true, branchId: true },
    });
    await this.audit.record(tx, actor, {
      branchId: shipment.branchId,
      entity: 'SHIPMENT',
      entityId: shipmentId,
      reference: shipment.number,
      action: 'UPDATED',
      changes: [
        ...((before?.broughtByPartnerId ?? null) !== facts.broughtByPartnerId
          ? [
              {
                field: 'broughtByPartnerId',
                before: before?.broughtByPartnerId ?? null,
                after: facts.broughtByPartnerId,
              },
            ]
          : []),
        ...((before?.firstForCustomerId ?? null) !== facts.firstForCustomerId
          ? [
              {
                field: 'referralFirstFor',
                before: before?.firstForCustomerId ?? null,
                after: facts.firstForCustomerId,
              },
            ]
          : []),
        ...slotChanges(before, slot),
        ...(reason ? [{ field: 'broughtByReason', before: null, after: reason }] : []),
      ],
    });
  }

  /** Serializes taking and freeing a customer's first (see the lock order above). */
  private async lockFirstInTx(tx: Tx, customerId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`referral-first:${customerId}`}, 0))`;
  }
}

type ReferralRow = {
  broughtByPartnerId: string | null;
  referrerId: string | null;
  referrerReason: 'FIRST_SHIPMENT' | 'BROUGHT_IN_PERSON' | null;
  firstForCustomerId: string | null;
};
type Slot = Pick<ReferralRow, 'referrerId' | 'referrerReason'>;

/**
 * Plan 18, 4.2: the slot. A shipment holding its customer's first pays that customer's broker
 * (kept from when it took the first), even when another broker brought it (⭐ owner's rule: the first
 * paid shipment goes to whoever registered the customer; flip here to change it). Else the broker
 * who brought it in person. Else no one.
 */
export function decide(facts: {
  broughtByPartnerId: string | null;
  firstForCustomerId: string | null;
  firstReferrerId: string | null;
}): Slot {
  if (facts.firstForCustomerId && facts.firstReferrerId) {
    return { referrerId: facts.firstReferrerId, referrerReason: 'FIRST_SHIPMENT' };
  }
  if (facts.broughtByPartnerId) {
    return { referrerId: facts.broughtByPartnerId, referrerReason: 'BROUGHT_IN_PERSON' };
  }
  return { referrerId: null, referrerReason: null };
}

function slotChanges(before: Slot | null, after: Slot) {
  const was = before?.referrerId ? `${before.referrerId} ${before.referrerReason}` : null;
  const now = after.referrerId ? `${after.referrerId} ${after.referrerReason}` : null;
  return was === now ? [] : [{ field: 'referrer', before: was, after: now }];
}

/** Whole days from one ISO day to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
