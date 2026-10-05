import { Injectable } from '@nestjs/common';
import type { AuditAction, AuditChangeDto, AuditEntity, AuditLogEntryDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { type AuditQuery, andIf, sqlDate, uuidList } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/** Rows per INSERT (keeps the statement under PostgreSQL's parameter limit). */
const WRITE_CHUNK = 1000;

/** The records this log keeps (the others keep their own history). */
export type AuditedEntity = Extract<AuditEntity, 'RATE' | 'CUSTOMER' | 'USER'>;

export interface AuditRecord {
  /** Null for records of no branch (user accounts). */
  branchId: string | null;
  entity: AuditedEntity;
  entityId: string;
  reference: string;
  action: Extract<AuditAction, 'CREATED' | 'UPDATED' | 'APPROVED' | 'CANCELLED'>;
  changes: AuditChangeDto[];
}

/** A field's value as the log shows it: decimals as written, dates as YYYY-MM-DD, lists joined. */
export type AuditValue =
  string | number | boolean | Date | Prisma.Decimal | null | undefined | readonly string[];

// Array.isArray narrows a readonly array to any[]: this keeps its element type.
function isList(value: AuditValue): value is readonly string[] {
  return Array.isArray(value);
}

function asText(value: AuditValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Prisma.Decimal.isDecimal(value)) return value.toFixed();
  if (isList(value)) return [...value].sort().join(', ');
  return String(value);
}

/**
 * The fields of `after` whose text differs from `before`, in the order of `fields`. Dates are
 * compared by day (date columns), decimals by value.
 */
export function changedFields<T extends Record<string, AuditValue>>(
  before: Partial<T> | null,
  after: T,
  fields: readonly (keyof T & string)[],
): AuditChangeDto[] {
  const changes: AuditChangeDto[] = [];
  for (const field of fields) {
    const was = before ? asText(before[field]) : null;
    const now = asText(after[field]);
    if (was !== now) changes.push({ field, before: was, after: now });
  }
  return changes;
}

/**
 * The audit log of records that keep no history of their own (annex E scenario 21): who changed
 * a rate, customer or user account, when, the fields before and after, and the channel. Each
 * module records its changes here inside the transaction that makes them, so a change and its log
 * row are written together or not at all.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a change made by `user` through the staff API (source USER). An update that changed
   * nothing is not recorded.
   */
  async record(tx: Tx, user: { id: string }, record: AuditRecord): Promise<void> {
    await this.recordMany(tx, user, [record]);
  }

  /** Several changes at once (an Excel import), in chunks of one INSERT each. */
  async recordMany(tx: Tx, user: { id: string }, records: readonly AuditRecord[]): Promise<void> {
    const data = records
      .filter((r) => r.action !== 'UPDATED' || r.changes.length > 0)
      .map((r) => ({
        branchId: r.branchId,
        userId: user.id,
        source: 'USER' as const,
        entity: r.entity,
        entityId: r.entityId,
        reference: r.reference.slice(0, 300),
        action: r.action,
        changes: r.changes as unknown as Prisma.InputJsonValue,
      }));
    for (let i = 0; i < data.length; i += WRITE_CHUNK) {
      await tx.auditEvent.createMany({ data: data.slice(i, i + WRITE_CHUNK) });
    }
  }

  /**
   * For the audit log report: the changes recorded in the period, newest first, in the report's
   * branches. Changes to user accounts (no branch) are listed only for those who manage users
   * (users:view) and only when no single branch is asked for.
   */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    const withUsers = user.permissions.has('users:view') && !q.branchId;
    if (branchIds.length === 0 && !withUsers) return [];
    const inBranches =
      branchIds.length > 0
        ? Prisma.sql`x."branch_id" IN ${uuidList(branchIds)}`
        : Prisma.sql`false`;
    const scope = withUsers ? Prisma.sql`(${inBranches} OR x."branch_id" IS NULL)` : inBranches;
    const rows = await this.prisma.$queryRaw<
      {
        at: Date;
        branchCode: string | null;
        userId: string | null;
        userName: string | null;
        entity: AuditedEntity;
        action: AuditRecord['action'];
        reference: string;
        changes: AuditChangeDto[];
        source: 'USER' | 'API' | 'SYSTEM';
      }[]
    >`
      SELECT x."occurred_at" AS "at", b."code" AS "branchCode", x."user_id" AS "userId",
             u."full_name" AS "userName", x."entity", x."action", x."reference", x."changes",
             x."source"::text AS "source"
      FROM "audit_events" x
      LEFT JOIN "branches" b ON b."id" = x."branch_id"
      LEFT JOIN "users" u ON u."id" = x."user_id"
      WHERE ${scope}
        AND (x."occurred_at" AT TIME ZONE coalesce(b."timezone", 'UTC'))::date
            BETWEEN ${sqlDate(q.from)} AND ${sqlDate(q.to)}
        ${andIf(q.userId, (id) => Prisma.sql`x."user_id" = ${id}::uuid`)}
        ${andIf(q.entity, (e) => Prisma.sql`x."entity" = ${e}`)}
      ORDER BY x."occurred_at" DESC, x."id" DESC
      LIMIT ${q.limit + 1}`;
    return rows.map((r) => ({
      at: r.at.toISOString(),
      branchCode: r.branchCode ?? '—',
      userId: r.userId,
      userName: r.userName,
      entity: r.entity,
      action: r.action,
      reference: r.reference,
      status: null,
      detail: null,
      changes: r.changes,
      source: r.source,
    }));
  }
}
