import { ConflictException, HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { requireApprovable } from './draft-completeness.js';
import { decideInTx } from './drafts.service.js';
import type { Prisma } from '../generated/prisma/client.js';

// The decision skeleton runs an approval's gate under the draft's row lock: after the version
// check, before the record is written; an approved draft is left as it is (idempotent).

const ID = '6f1c1b5e-0d7e-4c1a-9a51-1f2a3b4c5d6e';
const LATER = new Date(Date.now() + 86_400_000);

/** A transaction whose row lock returns this draft row. */
function txWith(row: { state: string; version: number }): Prisma.TransactionClient {
  const queryRaw = vi.fn().mockResolvedValue([{ id: ID, ...row, expires_at: LATER }]);
  return { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
}

function spec(version: number, calls: string[], incomplete: boolean) {
  return {
    table: 'invoice_drafts' as const,
    id: ID,
    version,
    label: 'invoice draft',
    approving: true,
    lockParents: () => {
      calls.push('lockParents');
      return Promise.resolve();
    },
    gate: () => {
      calls.push('gate');
      requireApprovable({ missing: incomplete ? ['currency'] : [], invalid: [] });
      return Promise.resolve();
    },
    record: () => {
      calls.push('record');
      return Promise.resolve();
    },
  };
}

describe('decideInTx: the approval gate', () => {
  it('runs after the parents are locked and before the record', async () => {
    const calls: string[] = [];
    const tx = txWith({ state: 'DRAFT', version: 3 });
    await expect(decideInTx(tx, spec(3, calls, false))).resolves.toBe(true);
    expect(calls).toEqual(['lockParents', 'gate', 'record']);
  });

  it('refuses an incomplete draft (422) and writes nothing', async () => {
    const calls: string[] = [];
    const tx = txWith({ state: 'DRAFT', version: 3 });
    const refused = decideInTx(tx, spec(3, calls, true));
    await expect(refused).rejects.toBeInstanceOf(HttpException);
    await expect(refused).rejects.toMatchObject({ status: 422 });
    expect(calls).toEqual(['lockParents', 'gate']);
  });

  it('checks the version before the gate: a stale version is a conflict, not a 422', async () => {
    const calls: string[] = [];
    const tx = txWith({ state: 'DRAFT', version: 4 });
    await expect(decideInTx(tx, spec(3, calls, true))).rejects.toBeInstanceOf(ConflictException);
    expect(calls).toEqual(['lockParents']);
  });

  it('leaves an approved draft as it is, gate and record unrun', async () => {
    const calls: string[] = [];
    const tx = txWith({ state: 'APPROVED', version: 4 });
    await expect(decideInTx(tx, spec(3, calls, true))).resolves.toBe(false);
    expect(calls).toEqual(['lockParents']);
  });
});
