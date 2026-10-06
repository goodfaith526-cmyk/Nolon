import type { Permission, Role } from '@nolon/shared';
import type { Request } from 'express';

/** The signed-in user, rebuilt from the database on every request (plan S3). */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  preferredLocale: string;
  sessionId: string;
  /**
   * SHA-256 of the password hash as it was when this request was authenticated (never the hash
   * itself). A write that relies on the request's credentials (issuing an assistant code)
   * re-checks it under the user row lock, so a request that started before a password change or
   * reset cannot act after it.
   */
  credentialStamp: string;
  roles: Role[];
  permissions: ReadonlySet<Permission>;
  /** Administrator / Management: true, and allowedBranchIds lists every branch. */
  allBranches: boolean;
  /** The only branches this user may read or write. Services filter on this list. */
  allowedBranchIds: readonly string[];
  /**
   * Set when the staff AI assistant acts for this user with a delegated token (agent-auth): the
   * same roles and branches, on read-only routes marked @AgentReadable() only.
   */
  agent?: { clientId: string; tokenId: string };
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}
