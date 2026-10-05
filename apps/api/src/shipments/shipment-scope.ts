import type { AuthUser } from '../auth/auth-user.js';
import { Prisma } from '../generated/prisma/client.js';
import { uuidList } from '../common/report-sql.js';

/**
 * Who may see a shipment (AGENTS.md rule 2, annex A): the users of the branch that owns it and of
 * the other branches working on it (shipment_branches: a DXB → KRT shipment is worked on in Port
 * Sudan and Khartoum too: goods receipt, customs, the delivery trip). Billing stays with the
 * owning branch, which uses `branchScope` instead.
 *
 * Returned under `AND`, so it can be spread next to a caller's own `OR`.
 */
export function shipmentScope(user: AuthUser): Prisma.ShipmentWhereInput {
  const ids = [...user.allowedBranchIds];
  return {
    AND: [
      {
        OR: [{ branchId: { in: ids } }, { sharedBranches: { some: { branchId: { in: ids } } } }],
      },
    ],
  };
}

/** The branches a shipment is visible in: its own and the ones sharing it. */
export function shipmentBranches(s: {
  branchId: string;
  sharedBranchIds: readonly string[];
}): string[] {
  return [s.branchId, ...s.sharedBranchIds];
}

/**
 * SQL for reports: the shipment under `alias` is visible in one of `branchIds` (its own branch or
 * a branch sharing it). `branchIds` must not be empty.
 */
export function shipmentVisibleIn(alias: string, branchIds: readonly string[]): Prisma.Sql {
  const s = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(${s}."branch_id" IN ${uuidList(branchIds)} OR EXISTS (
    SELECT 1 FROM "shipment_branches" sb
    WHERE sb."shipment_id" = ${s}."id" AND sb."branch_id" IN ${uuidList(branchIds)}))`;
}

/**
 * SQL for reports on rows under a shipment (warehouse movements, customs): `column` holds the id
 * of a shipment visible in one of `branchIds`. `branchIds` must not be empty.
 */
export function shipmentIdVisibleIn(column: Prisma.Sql, branchIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`${column} IN (SELECT vs."id" FROM "shipments" vs WHERE ${shipmentVisibleIn('vs', branchIds)})`;
}

/**
 * SQL for figures that belong to the shipment's owner (profitability): `column` holds the id of a
 * shipment owned by one of `branchIds`. `branchIds` must not be empty.
 */
export function shipmentIdOwnedBy(column: Prisma.Sql, branchIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`${column} IN (SELECT os."id" FROM "shipments" os WHERE os."branch_id" IN ${uuidList(branchIds)})`;
}
