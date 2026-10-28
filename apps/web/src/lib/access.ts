/**
 * Display helpers for the permissions screens (docs/plans/03-permissions-screen.md, section 6).
 * They only shape what the API returned for the screen; every rule is checked by the API.
 */
import {
  PERMISSION_ACTIONS,
  type Permission,
  type PermissionAction,
  type PermissionModule,
} from '@nolon/shared';
import { ApiError } from './api';

/**
 * The annex letters (A): F full, A view and approve, E view/create/update, V view only, N none.
 * `C` is a set of actions the annex has no letter for (shown as a custom cell).
 */
export type AccessLevel = 'F' | 'A' | 'E' | 'V' | 'N' | 'C';

const LEVELS: readonly {
  level: Exclude<AccessLevel, 'C'>;
  actions: readonly PermissionAction[];
}[] = [
  { level: 'F', actions: ['view', 'create', 'update', 'approve', 'cancel'] },
  { level: 'A', actions: ['view', 'approve'] },
  { level: 'E', actions: ['view', 'create', 'update'] },
  { level: 'V', actions: ['view'] },
  { level: 'N', actions: [] },
];

/** The actions of one module in a set of permissions, in PERMISSION_ACTIONS order. */
export function moduleActions(
  permissions: readonly Permission[],
  module: PermissionModule,
): PermissionAction[] {
  const held = new Set(permissions);
  return PERMISSION_ACTIONS.filter((action) => held.has(`${module}:${action}`));
}

/** The annex letter of a module in a set of permissions. */
export function accessLevel(
  permissions: readonly Permission[],
  module: PermissionModule,
): AccessLevel {
  const held = moduleActions(permissions, module);
  const match = LEVELS.find(
    ({ actions }) => actions.length === held.length && actions.every((a) => held.includes(a)),
  );
  return match ? match.level : 'C';
}

/** Whether two sets of permissions hold the same permissions (order does not matter). */
export function samePermissions(a: readonly Permission[], b: readonly Permission[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((p) => right.has(p));
}

/** Whether a module's actions differ between two sets (a team's cell against its defaults). */
export function moduleDiffers(
  a: readonly Permission[],
  b: readonly Permission[],
  module: PermissionModule,
): boolean {
  return accessKey(a, module) !== accessKey(b, module);
}

function accessKey(permissions: readonly Permission[], module: PermissionModule): string {
  return moduleActions(permissions, module).join(',');
}

/** A set with one permission turned on or off, sorted. */
export function togglePermission(
  permissions: readonly Permission[],
  permission: Permission,
  on: boolean,
): Permission[] {
  const next = new Set(permissions);
  if (on) next.add(permission);
  else next.delete(permission);
  return [...next].sort();
}

/** The permissions of `before` that `after` no longer holds: a smaller delegation ceiling. */
export function removedPermissions(
  before: readonly Permission[],
  after: readonly Permission[],
): Permission[] {
  const kept = new Set(after);
  return before.filter((p) => !kept.has(p));
}

/** The modules a list of permissions touches, in the order of `modules`. */
export function modulesOf(
  modules: readonly PermissionModule[],
  permissions: readonly Permission[],
): PermissionModule[] {
  const touched = new Set(permissions.map((p) => p.slice(0, p.indexOf(':'))));
  return modules.filter((m) => touched.has(m));
}

/** The message key for a failed permissions request. */
export type AccessErrorKey = 'stale' | 'conflict' | 'noAccess' | 'invalid' | 'notFound' | 'failed';

export function accessErrorKey(e: unknown): AccessErrorKey {
  if (!(e instanceof ApiError)) return 'failed';
  // The API answers 409 "Permissions changed..." when the rows moved while the screen was open.
  if (e.status === 409 && /permissions changed/i.test(e.message)) return 'stale';
  if (e.status === 409) return 'conflict';
  if (e.status === 403) return 'noAccess';
  if (e.status === 404) return 'notFound';
  if (e.status === 400) return 'invalid';
  return 'failed';
}
