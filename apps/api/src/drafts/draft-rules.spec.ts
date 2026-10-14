import { ConflictException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { dec } from '../common/money.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  draftExpiry,
  draftStatus,
  metaAfterEdit,
  metaForAi,
  preCheck,
  preCheckBody,
  requestHash,
  requireOpen,
  sameStoredValue,
} from './draft-rules.js';
import { checkRequest, lockDraftRow, valuesOf } from './drafts.service.js';
import { codedRefusal, fieldRefusal, parse } from '../common/validation.js';

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

describe('pre-checks', () => {
  const HASH = 'a'.repeat(64);

  it('pass with the totals the checks gave, or none', async () => {
    expect(await preCheck(HASH, () => Promise.resolve())).toEqual({
      ok: true,
      valuesHash: HASH,
      total: null,
      currency: null,
      priceSources: null,
      computed: [],
    });
    const priced = await preCheck(HASH, () =>
      Promise.resolve({ total: '10', currency: 'USD', priceSources: [] }),
    );
    expect(priced).toMatchObject({ ok: true, total: '10', currency: 'USD', priceSources: [] });
  });

  it('turn a field refusal into one refusal per field, with its code', async () => {
    const result = await preCheck(HASH, () =>
      Promise.reject(fieldRefusal('SAME_ROUTE', 'Origin and destination must differ', ['a', 'b'])),
    );
    expect(result).toEqual({
      ok: false,
      valuesHash: HASH,
      refusals: [
        {
          field: 'a',
          code: 'SAME_ROUTE',
          message: 'Origin and destination must differ',
          params: {},
        },
        {
          field: 'b',
          code: 'SAME_ROUTE',
          message: 'Origin and destination must differ',
          params: {},
        },
      ],
    });
  });

  it('keep a coded refusal with no field, and its params', async () => {
    const result = await preCheck(HASH, () =>
      Promise.reject(
        codedRefusal(HttpStatus.FORBIDDEN, 'CONTAINER_BRANCH_ONLY', 'Not yours', {
          container: 'C-1',
        }),
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      refusals: [
        {
          field: null,
          code: 'CONTAINER_BRANCH_ONLY',
          message: 'Not yours',
          params: { container: 'C-1' },
        },
      ],
    });
  });

  it('keep a plain refusal as its message, and a parse failure as its paths', async () => {
    const plain = await preCheck(HASH, () => Promise.reject(new ForbiddenException('No')));
    expect(plain).toMatchObject({
      ok: false,
      refusals: [{ field: null, code: null, message: 'No' }],
    });
    const parsed = await preCheck(HASH, () => {
      parse(z.object({ x: z.number() }), { x: 'no' });
      return Promise.resolve();
    });
    expect(parsed).toMatchObject({ ok: false, refusals: [{ field: 'x', code: 'INVALID' }] });
  });

  it('let any other failure through', async () => {
    await expect(preCheck(HASH, () => Promise.reject(new Error('db down')))).rejects.toThrow(
      'db down',
    );
  });

  it('refuse a malformed body per path, with no fingerprint and no check run', async () => {
    let ran = false;
    const result = await preCheckBody(
      z.object({ a: z.string(), b: z.number() }).strict(),
      { a: 1 },
      () => {
        ran = true;
        return preCheck(HASH, () => Promise.resolve());
      },
    );
    expect(ran).toBe(false);
    expect(result).toMatchObject({ ok: false, valuesHash: null });
    expect(!result.ok && result.refusals.map((x) => [x.field, x.code])).toEqual([
      ['a', 'INVALID'],
      ['b', 'INVALID'],
    ]);
  });

  it('check the values only: the key and the replaced draft are not part of them', () => {
    expect(checkRequest({ a: 1, idempotencyKey: 'mine', replacesDraftId: 'x' })).toEqual({
      a: 1,
      idempotencyKey: 'pre-check-only',
    });
    expect(checkRequest(null)).toBeNull();
    expect(valuesOf({ a: 1, idempotencyKey: 'k' })).toEqual({ a: 1 });
  });
});
