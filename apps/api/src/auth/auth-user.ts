import type { Role } from '@nolon/shared';
import type { Request } from 'express';
import type { Access } from '../access-control/access.js';

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
  /**
   * What this user may do in each branch (docs/plans/03-permissions-screen.md): permissions are
   * held per branch. Check a record's actions with `access.has(permission, record.branchId)`.
   */
  access: Access;
  /** Administrator / Management: true, and allowedBranchIds lists every branch. */
  allBranches: boolean;
  /**
   * The only branches this request may read or write. Services filter on this list. The guard
   * narrows it to the branches where the user holds every permission the route requires.
   */
  allowedBranchIds: readonly string[];
  /**
   * Outlet Staff (business model plan 4.2): the partner sales outlets whose records this user may
   * read or write, on top of the branch scope; an empty list sees nothing. Absent or null for
   * every other role. The guard refuses such a user on any route not marked @OutletScoped().
   */
  allowedOutletIds?: readonly string[] | null;
  /**
   * Set when the staff AI assistant acts for this user with a delegated token (agent-auth): the
   * same roles and branches, on read-only routes marked @AgentReadable() only.
   */
  agent?: { clientId: string; tokenId: string };
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}
