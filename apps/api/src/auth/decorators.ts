import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
  SetMetadata,
} from '@nestjs/common';
import type { Permission } from '@nolon/shared';
import type { AuthUser, AuthenticatedRequest } from './auth-user.js';

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_PERMISSIONS = 'auth:requiredPermissions';
export const AGENT_READABLE = 'auth:agentReadable';
export const AGENT_DRAFT_WRITABLE = 'auth:agentDraftWritable';

/** Opts a route out of the session guard. Every other route requires a signed-in user. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The signed-in user must hold every listed permission, or the request gets 403. */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * Opens a GET route to the staff AI assistant acting for a user with a delegated token
 * (agent-auth). Every other route refuses those tokens. The route's own @RequirePermission and
 * branch scoping still apply, with the user's own roles and branches. Mark only JSON reads the
 * pilot needs; never a write, an export or account administration.
 */
export const AgentReadable = () => SetMetadata(AGENT_READABLE, true);

/**
 * Opens a POST route to the staff AI assistant for creating a draft that only a person can
 * approve (Document Pilot). One route carries it: creating a GRN draft from a packing list
 * (agent-draft-writable.spec.ts). Never an approval, an edit, a delete or a posting.
 */
export const AgentDraftWritable = () => SetMetadata(AGENT_DRAFT_WRITABLE, true);

/** The user the guard attached. Only valid on routes that are not @Public(). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().authUser;
  if (!user) {
    throw new InternalServerErrorException('CurrentUser used on a route without a session');
  }
  return user satisfies AuthUser;
});
