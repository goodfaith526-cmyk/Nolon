import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@nolon/shared';
import type { AuthenticatedRequest } from './auth-user.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators.js';
import { SESSION_COOKIE, readCookie } from './session-token.js';

/**
 * Global guard: every route needs a valid session unless marked @Public(), and routes marked
 * @RequirePermission(...) also need every listed permission.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = token ? await this.auth.resolveSession(token) : null;
    if (!user) throw new UnauthorizedException('Not signed in');
    request.authUser = user;

    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets);
    if (required?.some((permission) => !user.permissions.has(permission))) {
      throw new ForbiddenException('Missing permission');
    }
    return true;
  }
}
