/** Emails are stored and looked up trimmed and lower-cased (the users table CHECKs this). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
