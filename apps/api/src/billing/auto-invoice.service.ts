import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-user.js';
import { BookingConfirmChecksRegistry } from '../bookings/booking-confirm-checks.registry.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { CreditLimitService } from './credit-limit.service.js';
import {
  type AutoInvoiceNote,
  type InvoiceDerivation,
  InvoicesService,
} from './invoices.service.js';

type Tx = Prisma.TransactionClient;

/** The rule an automatic approval used (plan 12 section 2.1). */
export type AutoApprovalRule = 'AGREED_PRICE' | 'RATE_CARD_WITH_RIGHT';

/**
 * Plan 12 section 2.1: whether the invoice made on confirmation may be approved by the system,
 * and under which rule; else why it stays a draft. Pure. (i) Every line priced from the agreed
 * quotation, whose terms still hash the same: AGREED_PRICE. (ii) Every line from approved rate
 * cards, and the person confirming may approve invoices in the booking's branch:
 * RATE_CARD_WITH_RIGHT. The switch off, a line left unpriced or offered, or anything else: a draft.
 */
export function autoApprovalRule(input: {
  enabled: boolean;
  derivation: Pick<InvoiceDerivation, 'lines' | 'unresolved'>;
  /**
   * The booking's quotation: null with none; `matches` when its pinned terms hash the same,
   * `reconciled` when its quantities are those of the booking's goods (agreedTermsReconciled).
   */
  agreed: { approved: boolean; matches: boolean; reconciled: boolean } | null;
  mayApprove: boolean;
  /** The shipment's booked services: priced from rate cards, each needs a line (Codex F193-2). */
  services: readonly string[];
}): { rule: AutoApprovalRule } | { note: AutoInvoiceNote } {
  const { lines, unresolved } = input.derivation;
  const filled = lines.filter((l) => l.use === 'FILL');
  const complete =
    lines.length > 0 &&
    unresolved.length === 0 &&
    lines.every((l) => l.use === 'FILL' && l.quantity !== null && l.unitPrice !== null);
  const sources = new Set(lines.map((l) => l.priceSource));
  if (input.agreed !== null && !(input.agreed.approved && input.agreed.matches)) {
    return { note: 'AGREED_TERMS_CHANGED' };
  }
  if (input.agreed !== null && !input.agreed.reconciled) return { note: 'AGREED_PRICE_MISMATCH' };
  if (!complete) return { note: 'PRICE_INCOMPLETE' };
  let rule: AutoApprovalRule;
  if (input.agreed !== null && sources.size === 1 && sources.has('QUOTATION')) {
    rule = 'AGREED_PRICE';
  } else if (input.agreed === null && sources.size === 1 && sources.has('RATE_CARD')) {
    // A booked service no rate card prices leaves the invoice short (the agreed terms already
    // hash the booked services, so a quotation needs no such check).
    if (!input.services.every((s) => filled.some((l) => l.service === s))) {
      return { note: 'PRICE_INCOMPLETE' };
    }
    if (!input.mayApprove) return { note: 'NO_APPROVE_RIGHT' };
    rule = 'RATE_CARD_WITH_RIGHT';
  } else {
    return { note: 'PRICE_INCOMPLETE' };
  }
  return input.enabled ? { rule } : { note: 'SWITCH_OFF' };
}

/** The refusals inside the savepoint that keep the draft instead of failing the confirmation. */
const KEEP_DRAFT_ON: ReadonlySet<string> = new Set(['PERIOD_CLOSED']);

function refusalCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  return typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    typeof body.code === 'string'
    ? body.code
    : null;
}

/**
 * Plan 12 section 2: the shipment's MAIN invoice, made when its booking is confirmed, as the LAST
 * step of every confirming transaction (registered as the bookings' final step, so the bookings
 * module never calls billing). It always makes the DRAFT when a line can be priced; it approves
 * it only under autoApprovalRule, inside a savepoint; it ends with the customer's credit check
 * under the credit advisory lock, the transaction's last lock. Server-only: no route reaches it
 * except through a booking's confirmation, and it approves only the invoice it just inserted.
 */
@Injectable()
export class AutoInvoiceService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly invoices: InvoicesService,
    private readonly credit: CreditLimitService,
    private readonly bookings: BookingsService,
    confirmChecks: BookingConfirmChecksRegistry,
  ) {
    confirmChecks.registerFinal((tx, booking) => this.lastStepInTx(tx, booking));
  }

  /**
   * Section 2.3, steps 2 to 6. `booking.user` is the person confirming. Refuses the whole
   * transaction only as plan 06's confirm check does (the balance before this invoice over the
   * limit, or a rate it needs missing): every other reason keeps the booking and the draft.
   */
  private async lastStepInTx(
    tx: Tx,
    booking: { id: string; customerId: string; user: AuthUser },
  ): Promise<void> {
    const { user } = booking;
    const shipment = await tx.shipment.findUnique({
      where: { bookingId: booking.id },
      select: { id: true, branchId: true, services: true },
    });
    if (!shipment) throw new Error(`Booking ${booking.id} was confirmed with no shipment`);
    const terms = await this.bookings.agreedTermsInTx(tx, booking.id);
    const agreed =
      terms === null
        ? null
        : {
            approved: terms.approved,
            matches: terms.pinned !== null && terms.pinned === terms.current,
            reconciled: terms.reconciled,
          };
    let derivation: InvoiceDerivation;
    try {
      derivation = await this.invoices.deriveForShipmentInTx(tx, shipment.id, {
        agreedTermsMatch: agreed !== null && agreed.approved && agreed.matches && agreed.reconciled,
      });
    } catch (error) {
      // A refusal of the derivation (an inactive currency, ...) leaves the shipment uninvoiced,
      // as the alert shows; it never refuses the confirmation. Reads only: the transaction is
      // untouched.
      if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
      await this.credit.requireWithinLimitInTx(tx, booking.customerId);
      return;
    }
    const draft = await this.invoices.insertDerivedDraftInTx(tx, user, derivation);
    if ('none' in draft) {
      // Nothing priced, or no rate: no invoice; the shipment shows as not invoiced (section 7).
      await this.credit.requireWithinLimitInTx(tx, booking.customerId);
      return;
    }
    const decided = autoApprovalRule({
      enabled: this.env.BILLING_AUTO_APPROVE_ENABLED,
      derivation,
      agreed,
      mayApprove:
        user.allowedBranchIds.includes(shipment.branchId) &&
        user.access.has('customer_invoices:approve', shipment.branchId),
      services: shipment.services,
    });
    if ('note' in decided) {
      await this.fallbackInTx(tx, draft.id, booking.customerId, decided.note);
      return;
    }
    await tx.$executeRaw`SAVEPOINT auto_invoice`;
    let refused: AutoInvoiceNote | null = null;
    try {
      await this.invoices.approveInTx(tx, user, draft.id, shipment.id, {
        approvedById: decided.rule === 'RATE_CARD_WITH_RIGHT' ? user.id : null,
        approvalSource: 'AUTO_ON_CONFIRM',
        autoRule: decided.rule,
        autoTermsHash: decided.rule === 'AGREED_PRICE' ? (terms?.current ?? null) : null,
      });
    } catch (error) {
      const code = refusalCode(error);
      if (code === null || !KEEP_DRAFT_ON.has(code)) throw error;
      refused = code as AutoInvoiceNote;
    }
    if (refused === null) {
      // Last: the credit lock and one statement. The balance before this invoice over the limit
      // refuses everything (409); with it over the limit, the approval is rolled back.
      const credit = await this.credit.autoApprovalCheckInTx(tx, booking.customerId, draft.id);
      if (credit === 'WITHIN') {
        await tx.$executeRaw`RELEASE SAVEPOINT auto_invoice`;
        return;
      }
      refused = credit;
    }
    // Undoes the number, the entry, the commissions and every lock taken since the savepoint.
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT auto_invoice`;
    await this.fallbackInTx(tx, draft.id, booking.customerId, refused);
  }

  /**
   * Section 2.3 step 5: the draft's note, then plan 06's own confirm check run again from scratch
   * as the last step (a fresh credit lock and statement; the draft does not count).
   */
  private async fallbackInTx(
    tx: Tx,
    invoiceId: string,
    customerId: string,
    note: AutoInvoiceNote,
  ): Promise<void> {
    await this.invoices.noteAutoDraftInTx(tx, invoiceId, note);
    await this.credit.requireWithinLimitInTx(tx, customerId);
  }
}
