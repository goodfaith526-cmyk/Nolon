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
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}
