import { DRIVER_OWN_TRIPS_ONLY, type PermissionModule, permissionsForRoles } from '@nolon/shared';
import type { AuthUser } from './auth-user.js';

/**
 * True when the user sees `module` only through the Driver role, which limits it to the trips
 * assigned to them (annex A). Another role that grants the module lifts the limit.
 */
export function limitedToOwnTrips(user: AuthUser, module: PermissionModule): boolean {
  if (!DRIVER_OWN_TRIPS_ONLY.includes(module) || !user.roles.includes('DRIVER')) return false;
  const others = user.roles.filter((role) => role !== 'DRIVER');
  return !permissionsForRoles(others).includes(`${module}:view`);
}
