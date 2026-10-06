import { ALERT_PERMISSIONS, type AlertKind } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';

/**
 * Whether `kind` concerns the user: they see its records. A Driver sees shipments only through
 * their own trips, so the late shipments alert (of all the branch's shipments) is not theirs.
 */
export function concerns(user: AuthUser, kind: AlertKind): boolean {
  if (!user.permissions.has(ALERT_PERMISSIONS[kind])) return false;
  if (kind === 'SHIPMENT_PAST_ETA') return !limitedToOwnTrips(user, 'shipments');
  return true;
}
