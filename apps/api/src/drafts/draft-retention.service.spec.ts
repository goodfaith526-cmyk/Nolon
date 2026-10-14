import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DRAFT_TABLES } from './drafts.service.js';
import {
  DraftRetentionService,
  PURGED_DRAFT_MODELS,
  retentionCutoff,
} from './draft-retention.service.js';

describe('draft retention purge', () => {
  it('covers every entry draft table', () => {
    // A new draft type is purged too, or this fails: its model ends in Draft.
    const drafts = Object.values(Prisma.ModelName).filter((m) => m.endsWith('Draft'));
    expect(Object.keys(PURGED_DRAFT_MODELS).sort()).toEqual([...drafts].sort());
    expect(drafts.length).toBe(12);
  });

  it('removes what was rejected or expired 90 days before the purge', () => {
    expect(retentionCutoff(new Date('2027-01-31T00:00:00Z')).toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
  });
});

describe('draft retention purge: bookings for a new customer', () => {
  it('removes a booking before its customer draft, and keeps a customer draft still named', async () => {
    const calls: { model: string; args: unknown }[] = [];
    const recorder = (model: string) => ({
      deleteMany: (args: unknown) => {
        calls.push({ model, args });
        return Promise.resolve({ count: 0 });
      },
    });
    const tx = Object.fromEntries(
      ['newCustomerBookingDraft', 'customerDraft'].map((m) => [m, recorder(m)]),
    );
    const cutoff = new Date('2026-01-01T00:00:00Z');
    // In the purge's order (the object's), the two linked models only.
    for (const [model, purge] of Object.entries(PURGED_DRAFT_MODELS)) {
      if (model === 'NewCustomerBookingDraft' || model === 'CustomerDraft') {
        await purge(tx as unknown as Prisma.TransactionClient, cutoff);
      }
    }
    expect(calls.map((c) => c.model)).toEqual(['newCustomerBookingDraft', 'customerDraft']);
    expect(calls[1]?.args).toMatchObject({ where: { newCustomerBookingDraft: { is: null } } });
  });
});

describe('draft retention purge: proposals', () => {
  it('removes a due proposal only when its draft is gone, never one of a kept draft', async () => {
    const deleted: unknown[] = [];
    const reviews: unknown[] = [];
    const settlements: unknown[] = [];
    const recorded: unknown[] = [];
    const tx = {
      $queryRaw: (strings: TemplateStringsArray) =>
        Promise.resolve(
          strings.join('').includes('advisory') ? [{ locked: true }] : [{ now: new Date() }],
        ),
      grnDraftProposal: {
        findMany: () => Promise.resolve([{ draftId: 'gone' }, { draftId: 'approved' }]),
        deleteMany: (args: unknown) => {
          deleted.push(args);
          return Promise.resolve({ count: 1 });
        },
      },
      grnDraft: {
        findMany: () => Promise.resolve([{ id: 'approved' }]),
        deleteMany: () => Promise.resolve({ count: 0 }),
      },
      ...Object.fromEntries(
        [
          'quotationDraft',
          'bookingDraft',
          'tripDraft',
          'goodsReleaseDraft',
          'invoiceDraft',
          'receiptDraft',
          'customerDraft',
          'shipmentStatusDraft',
          'partyDraft',
          'rateCardDraft',
          'newCustomerBookingDraft',
        ].map((m) => [m, { deleteMany: () => Promise.resolve({ count: 0 }) }]),
      ),
      assistantFormReview: {
        deleteMany: (args: unknown) => {
          reviews.push(args);
          return Promise.resolve({ count: 2 });
        },
      },
      assistantDraftKey: {
        deleteMany: (args: unknown) => {
          settlements.push(args);
          return Promise.resolve({ count: 3 });
        },
      },
      $executeRaw: (sql: TemplateStringsArray, ...values: unknown[]) => {
        recorded.push(values[0]);
        return Promise.resolve(0);
      },
    };
    const prisma = { $transaction: (work: (t: typeof tx) => unknown) => work(tx) };
    const service = new DraftRetentionService(
      prisma as unknown as PrismaService,
      { DRAFT_PURGE_EVERY_HOURS: 0 } as AppEnv,
    );
    const now = new Date();
    expect(await service.purge(now)).toMatchObject({
      skipped: false,
      grnProposals: 1,
      formReviews: 2,
      draftKeys: 3,
    });
    // Every draft table's purged keys go on the ledger first; a key's ledger row goes only once
    // acknowledged, and the retention period after that.
    expect(recorded).toEqual([...DRAFT_TABLES]);
    expect(settlements).toEqual([{ where: { ackedAt: { lte: retentionCutoff(now) } } }]);
    // A form kept for the assistant goes as soon as it has expired.
    expect(reviews).toEqual([{ where: { expiresAt: { lte: now } } }]);
    expect(deleted).toEqual([
      { where: { retainUntil: { lte: expect.any(Date) as Date }, draftId: { in: ['gone'] } } },
    ]);
  });
});
