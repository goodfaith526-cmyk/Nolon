import { randomUUID } from 'node:crypto';
import { POSTING_ROLES, ROLE_ACCOUNT_TYPES } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestApp, createTestApp } from './auth-test-app.js';

/**
 * PR-7a (docs/plans/07-business-model-batch-2.md, sections 3.2-3.4): the partner commission
 * ledger's database rules. Rows are written by rule 16 from PR-7b on; here they are written
 * straight to the tables, each test's own, in replica mode (the test database role is a
 * superuser) so they name no real shipment or entry, and are removed the same way afterwards.
 */
describe('partner commission ledger schema (PR-7a)', () => {
  let t: TestApp;
  const accruals: string[] = [];
  const statements: string[] = [];

  /** Writes with foreign keys and triggers off: rows of this test only. */
  const asReplica = (sql: (tx: TestApp['prisma']) => Promise<unknown>) =>
    t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await sql(tx as unknown as TestApp['prisma']);
    });

  const statement = async (over: { status?: string; billId?: string | null; total?: string }) => {
    const id = randomUUID();
    statements.push(id);
    await asReplica(
      (tx) => tx.$executeRaw`
        INSERT INTO "partner_statements" ("id", "number", "partner_id", "branch_id", "currency",
          "period_to", "total", "total_usd", "status", "bill_id", "created_by_id", "updated_at")
        VALUES (${id}::uuid, ${`IT-PST-${id.slice(0, 8)}`}, ${randomUUID()}::uuid,
          ${randomUUID()}::uuid, 'USD', DATE '2026-10-29', ${over.total ?? '50'}::numeric, 50,
          ${over.status ?? 'DRAFT'}::"partner_statement_status", ${over.billId ?? null}::uuid,
          ${randomUUID()}::uuid, CURRENT_TIMESTAMP)`,
    );
    return id;
  };

  const accrual = async (kind = 'ACCRUAL', reason: string | null = null) => {
    const id = randomUUID();
    accruals.push(id);
    await asReplica(
      (tx) => tx.$executeRaw`
        INSERT INTO "commission_accruals" ("id", "shipment_id", "partner_id", "role", "kind",
          "branch_id", "currency", "amount", "amount_usd", "entry_id", "reason", "created_by_id")
        VALUES (${id}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'SALES_OUTLET',
          ${kind}::"commission_accrual_kind", ${randomUUID()}::uuid, 'USD', 50, 50,
          ${randomUUID()}::uuid, ${reason}, ${randomUUID()}::uuid)`,
    );
    return id;
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await asReplica(async (tx) => {
      await tx.$executeRaw`DELETE FROM "commission_accruals" WHERE "id" = ANY(${accruals}::uuid[])`;
      await tx.$executeRaw`DELETE FROM "partner_statements" WHERE "id" = ANY(${statements}::uuid[])`;
    });
    await t.close();
  });

  it('maps the commission roles to the seeded accounts of the right type', async () => {
    expect(POSTING_ROLES).toEqual(
      expect.arrayContaining(['COMMISSION_COST', 'ACCRUED_COMMISSIONS']),
    );
    const mapped = await t.prisma.accountMapping.findMany({
      where: { role: { in: ['COMMISSION_COST', 'ACCRUED_COMMISSIONS'] } },
      include: { account: true },
    });
    expect(
      Object.fromEntries(mapped.map((m) => [m.role, [m.account.code, m.account.type]])),
    ).toEqual({
      COMMISSION_COST: ['5150', ROLE_ACCOUNT_TYPES.COMMISSION_COST],
      ACCRUED_COMMISSIONS: ['2310', ROLE_ACCOUNT_TYPES.ACCRUED_COMMISSIONS],
    });
  });

  it('never changes a row’s amounts, and never deletes one', async () => {
    const id = await accrual();
    await expect(
      t.prisma.$executeRaw`UPDATE "commission_accruals" SET "amount" = 60 WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/Commission rows cannot be changed or deleted/);
    await expect(
      t.prisma.$executeRaw`UPDATE "commission_accruals" SET "amount_usd" = 0, "statement_id" = NULL
        WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/Commission rows cannot be changed or deleted/);
    await expect(
      t.prisma.$executeRaw`DELETE FROM "commission_accruals" WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/Commission rows cannot be changed or deleted/);
  });

  it('lets a statement take a row and release it', async () => {
    const id = await accrual();
    const taking = await statement({});
    await t.prisma.$executeRaw`UPDATE "commission_accruals" SET "statement_id" = ${taking}::uuid
      WHERE "id" = ${id}::uuid`;
    await t.prisma.$executeRaw`UPDATE "commission_accruals" SET "statement_id" = NULL
      WHERE "id" = ${id}::uuid`;
    const row = await t.prisma.commissionAccrual.findUniqueOrThrow({ where: { id } });
    expect(row.statementId).toBeNull();
    expect(row.amount.toFixed()).toBe('50');
  });

  it('needs a reason on a manual adjustment', async () => {
    await expect(accrual('MANUAL')).rejects.toThrow(/commission_accruals_manual_reason_check/);
    await expect(accrual('MANUAL', '  ')).rejects.toThrow(/manual_reason_check/);
    await accrual('MANUAL', 'Agreed with the partner');
  });

  it('keeps a statement positive, and billed exactly when it names its bill', async () => {
    await expect(statement({ total: '0' })).rejects.toThrow(/partner_statements_positive_check/);
    await expect(statement({ status: 'BILLED' })).rejects.toThrow(/partner_statements_bill_check/);
    await expect(statement({ billId: randomUUID() })).rejects.toThrow(/bill_check/);
    await statement({ status: 'SETTLED', billId: randomUUID() });
  });
});
