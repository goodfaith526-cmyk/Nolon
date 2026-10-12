import type { DateString } from './commercial.js';
import type { Permission } from './auth.js';

/**
 * Internal alerts (scope section 15): fixed alerts, shown inside the system to the staff who work
 * on what they point at. The Administrator changes only how many days each waits
 * (alert_settings); alerts are not added or edited from the screens. SHIPMENT_ARRIVING_SOON looks
 * ahead instead: its days are how long before the ETA it shows.
 */
export const ALERT_KINDS = [
  'SHIPMENT_ARRIVING_SOON',
  'SHIPMENT_PAST_ETA',
  'INVOICE_OVERDUE',
  'CUSTOMS_STALLED',
  'STORAGE_EXCEEDED',
  'TRIP_LATE',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Who is concerned: those who see the records an alert points at (in their branches). */
export const ALERT_PERMISSIONS: Record<AlertKind, Permission> = {
  SHIPMENT_ARRIVING_SOON: 'shipments:view',
  SHIPMENT_PAST_ETA: 'shipments:view',
  INVOICE_OVERDUE: 'customer_invoices:view',
  CUSTOMS_STALLED: 'customs:view',
  STORAGE_EXCEEDED: 'warehouse:view',
  TRIP_LATE: 'transport_trips:view',
};

/** The longest wait an alert can be set to, in days. */
export const ALERT_MAX_DAYS = 365;

/** Rows listed per alert (the count says how many there are). */
export const ALERT_LIST_LIMIT = 100;

/**
 * One alert. `refId` is what it opens: the shipment (arriving, past ETA, customs, storage), the
 * invoice or the trip. `since` is the day the wait started (the ETA, due date, last customs
 * update, first day in the warehouse, planned arrival day); `days` is how long ago that was. For
 * SHIPMENT_ARRIVING_SOON, `since` is the ETA and `days` how many days until it (0: today).
 */
export interface AlertDto {
  kind: AlertKind;
  refId: string;
  number: string;
  branchCode: string;
  /** The customer, or for storage the warehouse code, or for customs the file's status. */
  detail: string | null;
  since: DateString;
  days: number;
}

export interface AlertGroupDto {
  kind: AlertKind;
  /** The wait set for this alert: it shows once `days` is more than this. */
  thresholdDays: number;
  count: number;
  items: AlertDto[];
}

/** GET /alerts: only the alerts the user is concerned by. */
export interface AlertsDto {
  groups: AlertGroupDto[];
  total: number;
}

export interface AlertSettingDto {
  kind: AlertKind;
  days: number;
  /** Null for an alert never set: it uses its starting wait. */
  updatedAt: string | null;
  updatedByName: string | null;
}

/** PUT /alerts/settings/:kind */
export interface AlertSettingUpdateRequest {
  days: number;
}
