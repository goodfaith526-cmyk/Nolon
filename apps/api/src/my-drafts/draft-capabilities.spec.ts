import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MY_DRAFT_KINDS, SETTLE_DRAFT_KINDS, type Permission } from '@nolon/shared';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/auth-user.js';
import { REVIEW_PAGES } from '../drafts/drafts.service.js';
import { DRAFT_KIND_ROUTES, draftCapabilities } from './draft-capabilities.js';

// The capabilities the assistant reads must say what the controllers do: the same routes, the
// same create permissions, a pre-check exactly where one exists, the review page "my drafts" uses.

const SRC = join(import.meta.dirname, '..');

const controllers = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('-drafts.controller.ts'))
  .map((file) => readFileSync(join(SRC, file), 'utf8'));

function controllerAt(path: string): string {
  const prefix = path.slice(1);
  const found = controllers.filter((text) => text.includes(`@Controller('${prefix}')`));
  expect(found, path).toHaveLength(1);
  return found[0]!;
}

describe('draft capabilities', () => {
  it('list every kind the assistant creates', () => {
    expect(Object.keys(DRAFT_KIND_ROUTES).sort()).toEqual([...SETTLE_DRAFT_KINDS].sort());
  });

  it("match each kind's controller: create permissions and pre-check", () => {
    for (const [kind, route] of Object.entries(DRAFT_KIND_ROUTES)) {
      const text = controllerAt(route.path);
      const create = /@Post\(\)\n\s*@RequirePermission\(([^)]*)\)\n\s*create\(/.exec(text)?.[1];
      expect(create, kind).toBeDefined();
      const permissions = [...(create ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(permissions, kind).toEqual([...route.create]);
      expect(text.includes("@Post('check')"), kind).toBe(route.preCheck);
    }
  });

  it('name the review page "my drafts" links to', () => {
    for (const kind of MY_DRAFT_KINDS) {
      const review =
        kind === 'grn' ? '/shipments/:shipmentId' : `/drafts/${REVIEW_PAGES[kind]}/:id`;
      expect(DRAFT_KIND_ROUTES[kind].review, kind).toBe(review);
    }
  });

  it("say which kinds this user may create, from the user's permissions now", () => {
    const user = { permissions: new Set<Permission>(['quotations:create']) } as unknown as AuthUser;
    const kinds = draftCapabilities(user).kinds;
    const can = kinds.filter((k) => k.canCreate).map((k) => k.kind);
    expect(can).toEqual(['quotation']);
    expect(kinds.find((k) => k.kind === 'quotation')?.approval).toBe('both');
    expect(kinds.find((k) => k.kind === 'new_customer_quotation')?.approval).toBe('screen');
    expect(kinds.find((k) => k.kind === 'grn')).toMatchObject({
      preCheck: true,
      review: '/shipments/:shipmentId',
      approval: 'screen',
    });
  });
});
