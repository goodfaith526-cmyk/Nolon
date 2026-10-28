import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../auth/auth-user.js';
import type { Prisma } from '../generated/prisma/client.js';
import { type PartnerChoice, PartnerRefsService } from './partner-refs.service.js';

const JED = 'b-jed';
const DXB = 'b-dxb';

const user = (extra: Partial<AuthUser> = {}) =>
  ({ id: 'u1', allowedBranchIds: [JED], allowedOutletIds: null, ...extra }) as AuthUser;

/** A transaction whose partners table holds `rows` (by id). */
function tx(rows: Record<string, { kind: string; branch_id: string; is_active: boolean }>) {
  const queryRaw = vi.fn((_sql: TemplateStringsArray, id: string) =>
    Promise.resolve(rows[id] ? [rows[id]] : []),
  );
  return { db: { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, queryRaw };
}

const choice = (extra: Partial<PartnerChoice>): PartnerChoice => ({
  kind: 'SALES_OUTLET',
  requested: undefined,
  held: null,
  branchIds: [JED],
  field: 'salesOutletId',
  ...extra,
});

const partners = {
  outlet: { kind: 'SALES_OUTLET', branch_id: JED, is_active: true },
  inactive: { kind: 'SALES_OUTLET', branch_id: JED, is_active: false },
  dxbOutlet: { kind: 'SALES_OUTLET', branch_id: DXB, is_active: true },
  distributor: { kind: 'DISTRIBUTOR', branch_id: JED, is_active: true },
};

describe('PartnerRefsService.chooseInTx', () => {
  const refs = new PartnerRefsService();

  it('keeps the held partner when none is sent, and removes it on null, without a lookup', async () => {
    const { db, queryRaw } = tx(partners);
    await expect(refs.chooseInTx(db, user(), choice({ held: 'inactive' }))).resolves.toBe(
      'inactive',
    );
    await expect(
      refs.chooseInTx(db, user(), choice({ held: 'outlet', requested: null })),
    ).resolves.toBeNull();
    // One it holds stays even if since deactivated.
    await expect(
      refs.chooseInTx(db, user(), choice({ held: 'inactive', requested: 'inactive' })),
    ).resolves.toBe('inactive');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('takes a newly named active partner of the kind and branches, share-locked', async () => {
    const { db, queryRaw } = tx(partners);
    await expect(refs.chooseInTx(db, user(), choice({ requested: 'outlet' }))).resolves.toBe(
      'outlet',
    );
    expect(queryRaw.mock.calls[0]?.[0].join('?')).toContain('FOR SHARE');
  });

  it('refuses one inactive, of another kind or branch, unknown, or of a branch not the user’s', async () => {
    const { db } = tx(partners);
    const refused = async (c: PartnerChoice, u = user()) => {
      const error = await refs.chooseInTx(db, u, c).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'PARTNER_NOT_USABLE',
        fields: [c.field],
      });
    };
    await refused(choice({ requested: 'inactive' }));
    await refused(choice({ requested: 'distributor' }));
    await refused(choice({ requested: 'dxbOutlet' }));
    await refused(choice({ requested: 'missing' }));
    // A branch the record allows (a shared one) but the user is not in.
    await refused(choice({ requested: 'dxbOutlet', branchIds: [JED, DXB] }));
    await expect(
      refs.chooseInTx(
        db,
        user({ allowedBranchIds: [DXB] }),
        choice({ requested: 'dxbOutlet', branchIds: [JED, DXB] }),
      ),
    ).resolves.toBe('dxbOutlet');
  });

  it('lets Outlet Staff record their own outlet only', async () => {
    const { db, queryRaw } = tx(partners);
    const staff = user({ allowedOutletIds: ['outlet'] });
    for (const requested of [undefined, 'outlet']) {
      await expect(refs.chooseInTx(db, staff, choice({ held: 'outlet', requested }))).resolves.toBe(
        'outlet',
      );
    }
    for (const requested of [null, 'distributor', 'inactive']) {
      await expect(
        refs.chooseInTx(db, staff, choice({ held: 'outlet', requested })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
