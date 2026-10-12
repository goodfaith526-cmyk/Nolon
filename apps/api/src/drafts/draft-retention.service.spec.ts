import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
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
    expect(drafts.length).toBe(11);
  });

  it('removes what was rejected or expired 90 days before the purge', () => {
    expect(retentionCutoff(new Date('2027-01-31T00:00:00Z')).toISOString()).toBe(
      '2026-11-02T00:00:00.000Z',
    );
  });
});

describe('draft retention purge: proposals', () => {
  it('removes a due proposal only when its draft is gone, never one of a kept draft', async () => {
    const deleted: unknown[] = [];
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
        ].map((m) => [m, { deleteMany: () => Promise.resolve({ count: 0 }) }]),
      ),
    };
    const prisma = { $transaction: (work: (t: typeof tx) => unknown) => work(tx) };
    const service = new DraftRetentionService(
      prisma as unknown as PrismaService,
      { DRAFT_PURGE_EVERY_HOURS: 0 } as AppEnv,
    );
    expect(await service.purge(new Date())).toMatchObject({ skipped: false, grnProposals: 1 });
    expect(deleted).toEqual([
      { where: { retainUntil: { lte: expect.any(Date) as Date }, draftId: { in: ['gone'] } } },
    ]);
  });
});
