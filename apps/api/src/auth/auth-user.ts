import type { Permission, Role } from '@nolon/shared';
import type { Request } from 'express';

/** The signed-in user, rebuilt from the database on every request (plan S3). */
export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  preferredLocale: string;
  sessionId: string;
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
