import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  draftExpiry,
  draftStatus,
  metaAfterEdit,
  metaForAi,
  requestHash,
  requireOpen,
  sameStoredValue,
} from './draft-rules.js';
import { lockDraftRow } from './drafts.service.js';

const FIELDS = ['customerId', 'amount', 'note'] as const;

describe('draft status and expiry', () => {
  it('expires seven days after creation', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(draftExpiry(now).toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });

  it('reads an undecided draft past its expiry as EXPIRED, a decided one as decided', () => {
    const at = new Date('2026-10-10T00:00:00Z');
    expect(draftStatus('DRAFT', at, at)).toBe('EXPIRED');
    expect(draftStatus('DRAFT', at, new Date(at.getTime() - 1))).toBe('DRAFT');
    expect(draftStatus('APPROVED', at, new Date(at.getTime() + 1))).toBe('APPROVED');
  });

  it('allows a change only on an open draft at the version read', () => {
    const open = { state: 'DRAFT' as const, expiresAt: new Date(Date.now() + 60_000), version: 3 };
    expect(() => requireOpen(open, 3, 'quotation draft')).not.toThrow();
    expect(() => requireOpen(open, 2, 'quotation draft')).toThrow(/changed since you opened it/);
    expect(() => requireOpen({ ...open, state: 'REJECTED' }, 3, 'quotation draft')).toThrow(
      /already decided/,
    );
    expect(() => requireOpen({ ...open, expiresAt: new Date(0) }, 3, 'quotation draft')).toThrow(
      ConflictException,
    );
  });
});

describe('field provenance', () => {
  it('marks AI values with the reported match, or the fallback (null without a document)', () => {
    const values = { customerId: 'c1', amount: dec('10.50'), note: null };
    expect(metaForAi(FIELDS, values, undefined, null)).toEqual({
      customerId: { filledBy: 'AI', match: null },
      amount: { filledBy: 'AI', match: null },
    });
    expect(metaForAi(FIELDS, values, { amount: 'MATCHED' }, 'UNVERIFIED')).toEqual({
      customerId: { filledBy: 'AI', match: 'UNVERIFIED' },
      amount: { filledBy: 'AI', match: 'MATCHED' },
    });
  });

  it('keeps provenance of unchanged values (decimals by value) and gives changes to STAFF', () => {
    const before = { customerId: 'c1', amount: dec('10.50'), note: null };
    const meta = metaForAi(FIELDS, before, undefined, null);
    const after = { customerId: 'c2', amount: dec('10.5'), note: 'typed' };
    expect(metaAfterEdit(FIELDS, { values: before, meta }, after)).toEqual({
      customerId: { filledBy: 'STAFF', match: null },
      amount: { filledBy: 'AI', match: null },
      note: { filledBy: 'STAFF', match: null },
    });
  });

  it('compares stored values by value, null only with null', () => {
    expect(sameStoredValue(dec('1.50'), dec('1.5'))).toBe(true);
    expect(sameStoredValue(new Date(5), new Date(5))).toBe(true);
    expect(sameStoredValue(null, '')).toBe(false);
    expect(sameStoredValue('a', 'a')).toBe(true);
  });
});

describe('request hash', () => {
  it('ignores key order and undefined, not values', () => {
    expect(requestHash({ a: 1, b: { c: '2', d: undefined } })).toBe(
      requestHash({ b: { c: '2' }, a: 1 }),
    );
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe('draft row lock', () => {
  it('refuses a table that is not on the closed list before any SQL runs', async () => {
    const tx = {
      $queryRaw: () => {
        throw new Error('no SQL expected');
      },
    } as unknown as Prisma.TransactionClient;
    await expect(lockDraftRow(tx, 'users; --' as 'grn_drafts', 'x')).rejects.toThrow(
      /Not a draft table/,
    );
  });
});
