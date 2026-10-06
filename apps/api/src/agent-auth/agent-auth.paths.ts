/**
 * Server-to-server endpoints of the assistant's sign-in (under the API prefix). They authenticate
 * the platform by client id and secret in the body and never read a cookie, so the browser origin
 * check does not apply to them.
 */
export const AGENT_SERVER_PATHS = ['agent-auth/token', 'agent-auth/revoke'] as const;
