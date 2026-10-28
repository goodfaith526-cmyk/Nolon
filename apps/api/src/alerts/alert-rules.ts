import { ALERT_PERMISSIONS, type AlertKind } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { limitedToOwnTrips } from '../auth/own-trips.js';

/**
 * Whether `kind` concerns the user: they see its records. A Driver sees shipments only through
 * their own trips, so the shipment alerts (of all the branch's shipments) are not theirs.
 */
export function concerns(user: AuthUser, kind: AlertKind): boolean {
  if (!user.access.any(ALERT_PERMISSIONS[kind])) return false;
  if (kind === 'SHIPMENT_PAST_ETA' || kind === 'SHIPMENT_ARRIVING_SOON') {
    return !limitedToOwnTrips(user, 'shipments');
  }
  return true;
}
