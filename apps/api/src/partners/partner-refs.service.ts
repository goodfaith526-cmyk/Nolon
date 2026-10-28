import { ForbiddenException, Injectable } from '@nestjs/common';
import type { PartnerKind, PartnerRefDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { canAccessBranch } from '../auth/branch-scope.js';
import { outletLimited } from '../auth/outlet-scope.js';
import { fieldRefusal } from '../common/validation.js';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** How a customer, quotation, booking or shipment reads the partner it names. */
export const partnerRefSelect = {
  select: { id: true, number: true, name: true, isActive: true },
} satisfies Prisma.PartnerDefaultArgs;

export function toPartnerRef(
  p: { id: string; number: string; name: string; isActive: boolean } | null,
): PartnerRefDto | null {
  return p && { id: p.id, number: p.number, name: p.name, isActive: p.isActive };
}

/** A partner a record names, as the request sent it. */
export interface PartnerChoice {
  kind: PartnerKind;
  /** As sent: undefined keeps `held`, null removes it. */
  requested: string | null | undefined;
  /** The partner the record names now (on a create: none, or the Outlet Staff user's outlet). */
  held: string | null;
  /** The branches a newly named partner may belong to (the record's, and those sharing it). */
  branchIds: readonly string[];
  /** The request field, for a refusal. */
  field: string;
}

/**
 * The partners a customer, quotation, booking or shipment names (business model plan 3.3, PR-3):
 * its sales outlet, origin consolidator and distributor. Partners are branch-owned master data,
 * so a record names only an active partner of the right kind of its own branches.
 */
@Injectable()
export class PartnerRefsService {
  /**
   * The partner the record names after this write. One it already holds stays, even if since
   * deactivated (the record was right when written). A newly named one is share-locked until the
   * caller commits, so it stays active and of its branch meanwhile; it must be of `kind`, active,
   * of one of `branchIds` and of the user's branches (400 on the field otherwise, the same for one
   * that does not exist, so another branch's partners are not disclosed).
   *
   * Outlet Staff (plan 4.2): the record names their own outlet, `held`, which the caller has
   * checked inside the transaction (outletForWriteInTx, assertOutletInTx); naming any other, or
   * none, is refused (403).
   */
  async chooseInTx(tx: Tx, user: AuthUser, choice: PartnerChoice): Promise<string | null> {
    const { requested, held } = choice;
    if (requested === undefined) return held;
    if (outletLimited(user)) {
      if (requested !== held) {
        throw new ForbiddenException('Outlet Staff record their own sales outlet only');
      }
      return held;
    }
    if (requested === null || requested === held) return requested;
    const rows = await tx.$queryRaw<{ kind: string; branch_id: string; is_active: boolean }[]>`
      SELECT "kind"::text AS "kind", "branch_id", "is_active" FROM "partners"
      WHERE "id" = ${requested}::uuid FOR SHARE`;
    const partner = rows[0];
    if (
      !partner?.is_active ||
      partner.kind !== choice.kind ||
      !choice.branchIds.includes(partner.branch_id) ||
      !canAccessBranch(user, partner.branch_id)
    ) {
      throw fieldRefusal(
        'PARTNER_NOT_USABLE',
        `Not an active ${choice.kind} partner of this record's branches`,
        [choice.field],
      );
    }
    return requested;
  }
}
