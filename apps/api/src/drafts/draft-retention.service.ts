import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DRAFT_RETENTION_DAYS } from '@nolon/shared';
import { APP_ENV, type AppEnv } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DRAFT_TABLES, recordPurgedKeysInTx } from './drafts.service.js';

/**
 * The retention purge of entry drafts (data governance v2.1, section 4). "Expired" never meant
 * deleted: this removes, with their lines, every draft rejected more than DRAFT_RETENTION_DAYS
 * ago and every undecided draft that expired more than that long ago. An approved draft is kept:
 * it is the record behind the entry it created, and follows NOLON's own retention. The record of
 * what the assistant proposed for a GRN draft (grn_draft_proposals) goes once its retain_until
 * has passed and its draft is gone; the database refuses removing it any earlier, and the
 * proposal of an approved draft stays with it.
 *
 * System maintenance, not a request: it reads and deletes across branches, and no user acts.
 * Runs in one transaction under an advisory lock, so two API processes never purge at once.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const START_DELAY_MS = 60_000;
/** pg advisory lock key: "nolon draft retention". */
const LOCK_KEY = 72_031_011;

type Tx = Prisma.TransactionClient;

/** Removable: rejected, or never decided and expired, before the cutoff. */
function removable(cutoff: Date) {
  return {
    OR: [
      { state: 'REJECTED' as const, decidedAt: { lte: cutoff } },
      { state: 'DRAFT' as const, expiresAt: { lte: cutoff } },
    ],
  };
}

/** Every entry draft table, by its Prisma model (a test checks no draft model is missing). */
export const PURGED_DRAFT_MODELS = {
  GrnDraft: (tx: Tx, cutoff: Date) => tx.grnDraft.deleteMany({ where: removable(cutoff) }),
  QuotationDraft: (tx: Tx, cutoff: Date) =>
    tx.quotationDraft.deleteMany({ where: removable(cutoff) }),
  BookingDraft: (tx: Tx, cutoff: Date) => tx.bookingDraft.deleteMany({ where: removable(cutoff) }),
  TripDraft: (tx: Tx, cutoff: Date) => tx.tripDraft.deleteMany({ where: removable(cutoff) }),
  GoodsReleaseDraft: (tx: Tx, cutoff: Date) =>
    tx.goodsReleaseDraft.deleteMany({ where: removable(cutoff) }),
  InvoiceDraft: (tx: Tx, cutoff: Date) => tx.invoiceDraft.deleteMany({ where: removable(cutoff) }),
  ReceiptDraft: (tx: Tx, cutoff: Date) => tx.receiptDraft.deleteMany({ where: removable(cutoff) }),
  // Before the customer drafts it names (a foreign key): a customer draft is kept while a
  // booking for it is.
  NewCustomerBookingDraft: (tx: Tx, cutoff: Date) =>
    tx.newCustomerBookingDraft.deleteMany({ where: removable(cutoff) }),
  NewCustomerQuotationDraft: (tx: Tx, cutoff: Date) =>
    tx.newCustomerQuotationDraft.deleteMany({ where: removable(cutoff) }),
  CustomerDraft: (tx: Tx, cutoff: Date) =>
    tx.customerDraft.deleteMany({
      where: { ...removable(cutoff), newCustomerBookingDraft: { is: null } },
    }),
  ShipmentStatusDraft: (tx: Tx, cutoff: Date) =>
    tx.shipmentStatusDraft.deleteMany({ where: removable(cutoff) }),
  PartyDraft: (tx: Tx, cutoff: Date) => tx.partyDraft.deleteMany({ where: removable(cutoff) }),
  RateCardDraft: (tx: Tx, cutoff: Date) =>
    tx.rateCardDraft.deleteMany({ where: removable(cutoff) }),
} satisfies Partial<Record<Prisma.ModelName, (tx: Tx, cutoff: Date) => Promise<{ count: number }>>>;

export type PurgedDraftModel = keyof typeof PURGED_DRAFT_MODELS;

export type DraftPurgeResult =
  | { skipped: true }
  | {
      skipped: false;
      /** Drafts removed per model (their lines go with them). */
      drafts: Record<PurgedDraftModel, number>;
      grnProposals: number;
      /** Forms kept for the assistant (assistant_form_reviews) that have expired. */
      formReviews: number;
      /** Acknowledged key outcomes (assistant_draft_keys) past the retention period. */
      draftKeys: number;
    };

/** The time before which a rejected or expired draft is removed, for a purge at `now`. */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - DRAFT_RETENTION_DAYS * DAY_MS);
}

@Injectable()
export class DraftRetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DraftRetentionService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  onApplicationBootstrap(): void {
    const hours = this.env.DRAFT_PURGE_EVERY_HOURS;
    if (hours === 0) return;
    const run = () => {
      this.purge().then(
        (result) => {
          if (!result.skipped) this.logger.log(`Draft retention purge: ${JSON.stringify(result)}`);
        },
        (error: unknown) => this.logger.error('Draft retention purge failed', error),
      );
    };
    this.timers.push(setTimeout(run, START_DELAY_MS).unref());
    this.timers.push(setInterval(run, hours * 60 * 60 * 1000).unref());
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Removes what retention allows at `now`; skipped when another purge holds the lock. */
  async purge(now: Date = new Date()): Promise<DraftPurgeResult> {
    const cutoff = retentionCutoff(now);
    return this.prisma.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`;
      if (!lock?.locked) return { skipped: true };
      // The outcome of every key whose draft goes, first and in this transaction: a settle after
      // the purge still answers CREATED (drafts.service.ts settleKeyInTx).
      for (const table of DRAFT_TABLES) await recordPurgedKeysInTx(tx, table, cutoff);
      const drafts = {} as Record<PurgedDraftModel, number>;
      for (const [model, purge] of Object.entries(PURGED_DRAFT_MODELS)) {
        drafts[model as PurgedDraftModel] = (await purge(tx, cutoff)).count;
      }
      // A proposal outlives a draft rejected early (its draft's expiry + the retention period),
      // and stays with an approved draft. The database refuses any removal before retain_until
      // by its own clock, so that clock bounds this one.
      const [db] = await tx.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS now`;
      const until = new Date(Math.min(now.getTime(), db?.now.getTime() ?? 0));
      const due = await tx.grnDraftProposal.findMany({
        where: { retainUntil: { lte: until } },
        select: { draftId: true },
      });
      const kept = await tx.grnDraft.findMany({
        where: { id: { in: due.map((p) => p.draftId) } },
        select: { id: true },
      });
      const keep = new Set(kept.map((d) => d.id));
      const { count: grnProposals } = await tx.grnDraftProposal.deleteMany({
        where: {
          retainUntil: { lte: until },
          draftId: { in: due.map((p) => p.draftId).filter((id) => !keep.has(id)) },
        },
      });
      // A form kept for the assistant is its author's input, read only until it expires: gone
      // at the first purge after that.
      const { count: formReviews } = await tx.assistantFormReview.deleteMany({
        where: { expiresAt: { lte: now } },
      });
      // A key settled as not created is kept as long as a closed draft and its key.
      // A key's ledger row goes only once the assistant acknowledged it, and as long after that
      // as a closed draft is kept; one never acknowledged stays.
      const { count: draftKeys } = await tx.assistantDraftKey.deleteMany({
        where: { ackedAt: { lte: cutoff } },
      });
      return { skipped: false, drafts, grnProposals, formReviews, draftKeys };
    });
  }
}
