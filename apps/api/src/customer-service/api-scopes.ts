import { SetMetadata } from '@nestjs/common';
import { CS_REQUEST_SERVICES, type CsRequestService, type CsScope } from '@nolon/shared';
import type { ApiScope } from '../generated/prisma/client.js';

export const API_SCOPE_KEY = 'nolon:apiScope';

/** The scope a Customer Service API route needs. ApiClientGuard refuses a route without one. */
export const RequireApiScope = (scope: CsScope) => SetMetadata(API_SCOPE_KEY, scope);

/**
 * The scopes kept in api_client_scopes. `cs:customers:read` is the api_clients.customers_read
 * column instead, so the keys made before scopes existed keep the reads they had.
 */
export const SCOPE_ROWS = {
  'cs:customer_tokens:issue': 'CUSTOMER_TOKENS_ISSUE',
  'cs:catalog:read': 'CATALOG_READ',
  'cs:quote:read': 'QUOTE_READ',
  'cs:booking_requests:create': 'BOOKING_REQUESTS_CREATE',
  'cs:tracking:lookup': 'TRACKING_LOOKUP',
} as const satisfies Record<Exclude<CsScope, 'cs:customers:read'>, ApiScope>;

const SCOPE_OF_ROW = new Map<ApiScope, CsScope>(
  Object.entries(SCOPE_ROWS).map(([scope, row]) => [row, scope as CsScope]),
);

/** A key's scopes, from its column and its rows, in CS_SCOPES order. */
export function keyScopes(
  customersRead: boolean,
  rows: readonly { scope: ApiScope }[],
  order: readonly CsScope[],
): CsScope[] {
  const held = new Set<CsScope>(rows.flatMap((r) => SCOPE_OF_ROW.get(r.scope) ?? []));
  if (customersRead) held.add('cs:customers:read');
  return order.filter((s) => held.has(s));
}

/** The rows for `scopes` (all but `cs:customers:read`). */
export function scopeRows(scopes: readonly CsScope[]): ApiScope[] {
  return scopes.flatMap((s) => (s === 'cs:customers:read' ? [] : [SCOPE_ROWS[s]]));
}
/** A key's services, from its columns, in CS_REQUEST_SERVICES order. */
export function keyServices(row: {
  offersPickup: boolean;
  offersLastMile: boolean;
}): CsRequestService[] {
  return CS_REQUEST_SERVICES.filter((s) =>
    s === 'PICKUP' ? row.offersPickup : row.offersLastMile,
  );
}
