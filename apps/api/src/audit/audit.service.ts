import { createHash } from 'node:crypto';
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

/** The master data entries this log keeps; they belong to no branch and are keyed by code. */
export const AUDITED_MASTER_DATA = [
  'CONTAINER_TYPE',
  'CHARGE_TYPE',
  'DOCUMENT_TYPE',
  'CURRENCY',
  'PRICE_CATEGORY',
  'CUSTOMER_SEGMENT',
] as const satisfies readonly AuditEntity[];
export type AuditedMasterData = (typeof AUDITED_MASTER_DATA)[number];

/** The records this log keeps (the others keep their own history). */
export type AuditedEntity =
  Extract<AuditEntity, 'RATE' | 'CUSTOMER' | 'USER' | 'PARTNER'> | AuditedMasterData;

/** Fixed namespace for codeEntityId (a random UUID, chosen once; never change it). */
const CODE_ENTITY_NAMESPACE = '6b1f4c9e-2d3a-4f57-9a1e-0c8d7e5b3f21';

/**
 * A stable uuid for a record keyed by a code (audit_events.entity_id is a uuid): a UUID version 5
 * (RFC 9562) of the entity and the code, so every change of one entry shares the same id.
 */
export function codeEntityId(entity: AuditedMasterData, code: string): string {
  const namespace = Buffer.from(CODE_ENTITY_NAMESPACE.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1').update(namespace).update(`${entity}:${code}`, 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
   * branches. Records of no branch are listed only when no single branch is asked for: changes to
   * user accounts for those who manage users (users:view), changes to master data for those who
   * read it (master_data:view, every role).
   */
  async auditEntries(user: AuthUser, q: AuditQuery): Promise<AuditLogEntryDto[]> {
    const branchIds = reportBranchIds(user, q.branchId);
    const unbranched: AuditedEntity[] = [];
    if (!q.branchId) {
      if (user.permissions.has('users:view')) unbranched.push('USER');
      if (user.permissions.has('master_data:view')) unbranched.push(...AUDITED_MASTER_DATA);
    }
    if (branchIds.length === 0 && unbranched.length === 0) return [];
    const inBranches =
      branchIds.length > 0
        ? Prisma.sql`x."branch_id" IN ${uuidList(branchIds)}`
        : Prisma.sql`false`;
    const scope =
      unbranched.length > 0
        ? Prisma.sql`(${inBranches} OR (x."branch_id" IS NULL AND x."entity" IN (${Prisma.join(unbranched)})))`
        : inBranches;
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
