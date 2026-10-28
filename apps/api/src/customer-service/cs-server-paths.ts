/**
 * Server-to-server writes of the Customer Service API (under the API prefix). They authenticate
 * by an API key in the Authorization header and never read a cookie (@Public, ApiClientGuard), so
 * the browser origin check does not apply to them.
 */
export const CS_SERVER_PATHS = ['cs/customer-tokens', 'cs/booking-requests'] as const;
