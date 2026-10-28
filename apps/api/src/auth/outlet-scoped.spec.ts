import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthUser } from './auth-user.js';
import {
  customerOutletScope,
  assertOutletInTx,
  outletForWriteInTx,
  outletLimited,
  partnerOutletScope,
  salesOutletScope,
} from './outlet-scope.js';

// Guards the routes open to Outlet Staff (@OutletScoped, business model plan 4.2). The guard
// refuses them every other route, so this list is all they can reach: each route's service
// narrows its reads and writes to the user's outlets. A new route is opened here on purpose only.

const SRC = join(import.meta.dirname, '..');

const OPEN = [
  'auth/auth.controller.ts GET me',
  'auth/auth.controller.ts POST password',
  'bookings/bookings.controller.ts GET ',
  'bookings/bookings.controller.ts GET :id',
  'bookings/bookings.controller.ts GET from-quotation/:quotationId',
  'bookings/bookings.controller.ts GET party-suggestion',
  'bookings/bookings.controller.ts PATCH :id',
  'bookings/bookings.controller.ts POST ',
  'bookings/bookings.controller.ts POST from-quotation/:quotationId',
  'customers/customers.controller.ts GET ',
  'customers/customers.controller.ts GET :id',
  'customers/customers.controller.ts PATCH :id',
  'customers/customers.controller.ts PATCH :id/contacts/:contactId',
  'customers/customers.controller.ts PATCH :id/parties/:partyId',
  'customers/customers.controller.ts POST ',
  'customers/customers.controller.ts POST :id/activate',
  'customers/customers.controller.ts POST :id/contacts',
  'customers/customers.controller.ts POST :id/deactivate',
  'customers/customers.controller.ts POST :id/parties',
  'documents/documents.controller.ts GET ',
  'documents/documents.controller.ts GET :documentId/file',
  'documents/documents.controller.ts GET :documentId/packing-list-content',
  'documents/documents.controller.ts GET :documentId/preview',
  'documents/documents.controller.ts GET :documentId/sheet',
  'documents/documents.controller.ts POST ',
  'master-data/master-data.controller.ts GET ',
  'partners/partners.controller.ts GET ',
  'partners/partners.controller.ts GET :id',
  'quotations/quotations.controller.ts GET ',
  'quotations/quotations.controller.ts GET :id',
  'quotations/quotations.controller.ts GET defaults',
  'quotations/quotations.controller.ts PATCH :id',
  'quotations/quotations.controller.ts POST ',
  'quotations/quotations.controller.ts POST :id/send',
  'rates/rates.controller.ts GET ',
  'rates/rates.controller.ts GET :id',
  'shipments/shipments.controller.ts GET ',
  'shipments/shipments.controller.ts GET :id',
];

/** `file METHOD path` of every handler carrying @OutletScoped(). */
function openedRoutes(): string[] {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.controller.ts'),
  );
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.trim() !== '@OutletScoped()') return;
      const block = lines.slice(i + 1, i + 6).join('\n');
      const route = /@(Get|Post|Patch|Put|Delete)\((?:'([^']*)')?\)/.exec(block);
      found.push(`${file.replaceAll('\\', '/')} ${route?.[1]?.toUpperCase()} ${route?.[2] ?? ''}`);
    });
  }
  return found.sort();
}

const user = (allowedOutletIds?: string[] | null): AuthUser => ({
  id: 'u',
  email: 'u@nolon.example',
  fullName: 'U',
  preferredLocale: 'ar',
  sessionId: 's',
  credentialStamp: 'c',
  roles: ['OUTLET_STAFF'],
  permissions: new Set(),
  allBranches: false,
  allowedBranchIds: ['b'],
  ...(allowedOutletIds !== undefined && { allowedOutletIds }),
});

describe('routes open to Outlet Staff', () => {
  it('are exactly the outlet-scoped reads and writes, nothing else', () => {
    expect(openedRoutes()).toEqual([...OPEN].sort());
  });

  it('never approve, confirm, cancel, delete, export or administer', () => {
    for (const route of openedRoutes()) {
      expect(route).not.toMatch(
        /approve|confirm|cancel|reject|expire|export|users|DELETE|import|status|by-token|qr/,
      );
    }
  });
});

describe('outlet scope', () => {
  it('limits only users with an outlet list, an empty one to nothing', () => {
    expect(outletLimited(user())).toBe(false);
    expect(outletLimited(user(null))).toBe(false);
    expect(customerOutletScope(user(null))).toEqual({});
    expect(salesOutletScope(user())).toEqual({});
    expect(partnerOutletScope(user())).toEqual({});
    expect(outletLimited(user([]))).toBe(true);
    expect(salesOutletScope(user([]))).toEqual({ salesOutletId: { in: [] } });
    expect(customerOutletScope(user(['o1']))).toEqual({ acquiredViaOutletId: { in: ['o1'] } });
    expect(partnerOutletScope(user(['o1']))).toEqual({ AND: [{ id: { in: ['o1'] } }] });
  });

  /**
   * A transaction whose share-locking reads return role, branches, links and outlets in turn, as
   * they are now: `outlets` maps each linked active outlet to its branch.
   */
  const tx = (outlets: Record<string, string>, { role = true, branches = ['b'] } = {}) => {
    const replies = [
      role ? [{ role: 'OUTLET_STAFF' }] : [],
      branches.map((branch_id) => ({ branch_id })),
      Object.keys(outlets).map((partner_id) => ({ partner_id })),
      Object.entries(outlets).map(([id, branch_id]) => ({ id, branch_id })),
    ];
    const $queryRaw = vi.fn(() => Promise.resolve(replies.shift() ?? []));
    return { client: { $queryRaw } as unknown as Prisma.TransactionClient, $queryRaw };
  };
  const changed = /access changed/;

  it('records the only outlet of an Outlet Staff user, of the write’s branch, and none for anyone else', async () => {
    const none = tx({ o1: 'b' });
    await expect(outletForWriteInTx(none.client, user(null), 'b')).resolves.toBeNull();
    expect(none.$queryRaw).not.toHaveBeenCalled();
    await expect(outletForWriteInTx(tx({ o1: 'b' }).client, user(['o1']), 'b')).resolves.toBe('o1');
    // Never an outlet of another branch than the record's.
    await expect(outletForWriteInTx(tx({ o1: 'b' }).client, user(['o1']), 'b2')).rejects.toThrow(
      /single sales outlet/,
    );
    // A user with no outlet now, as at sign-in, records nothing.
    await expect(outletForWriteInTx(tx({}).client, user([]), 'b')).rejects.toThrow(
      /single sales outlet/,
    );
    await expect(
      outletForWriteInTx(tx({ o1: 'b', o2: 'b' }).client, user(['o1', 'o2']), 'b'),
    ).rejects.toThrow(/single sales outlet/);
  });

  it('refuses the request when the access read under lock is not the sign-in snapshot', async () => {
    // Outlet deactivated or link removed.
    await expect(outletForWriteInTx(tx({}).client, user(['o1']), 'b')).rejects.toThrow(changed);
    // Out of the role.
    await expect(
      outletForWriteInTx(tx({ o1: 'b' }, { role: false }).client, user(['o1']), 'b'),
    ).rejects.toThrow(changed);
    // Moved to another outlet of the same branch, completed before this request's locks: the
    // refusal comes before any other check could use the stale outlet list.
    await expect(outletForWriteInTx(tx({ o2: 'b' }).client, user(['o1']), 'b')).rejects.toThrow(
      changed,
    );
    // Moved to another branch and its outlet.
    await expect(
      outletForWriteInTx(tx({ o2: 'b2' }, { branches: ['b2'] }).client, user(['o1']), 'b'),
    ).rejects.toThrow(changed);
    // Given a second outlet.
    await expect(
      assertOutletInTx(tx({ o1: 'b', o2: 'b' }).client, user(['o1']), 'o1', 'Gone'),
    ).rejects.toThrow(changed);
  });

  it('lets Outlet Staff write a record only of their own outlet', async () => {
    await expect(
      assertOutletInTx(tx({}).client, user(null), null, 'Gone'),
    ).resolves.toBeUndefined();
    await expect(
      assertOutletInTx(tx({ o1: 'b' }).client, user(['o1']), 'o1', 'Gone'),
    ).resolves.toBeUndefined();
    await expect(
      assertOutletInTx(tx({ o1: 'b' }).client, user(['o1']), 'o2', 'Gone'),
    ).rejects.toThrow('Gone');
    await expect(
      assertOutletInTx(tx({ o1: 'b' }).client, user(['o1']), null, 'Gone'),
    ).rejects.toThrow('Gone');
  });
});
