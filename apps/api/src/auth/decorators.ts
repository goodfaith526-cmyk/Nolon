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

/** Opts a route out of the session guard. Every other route requires a signed-in user. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The signed-in user must hold every listed permission, or the request gets 403. */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** The user the guard attached. Only valid on routes that are not @Public(). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().authUser;
  if (!user) {
    throw new InternalServerErrorException('CurrentUser used on a route without a session');
  }
  return user satisfies AuthUser;
});
