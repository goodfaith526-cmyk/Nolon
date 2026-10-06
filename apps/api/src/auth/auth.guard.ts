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
import { isAgentAuthorization, readAgentToken } from '../agent-auth/agent-secrets.js';
import { AGENT_READABLE, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators.js';
import { SESSION_COOKIE, readCookie } from './session-token.js';

/**
 * Global guard: every route needs a valid session unless marked @Public(), and routes marked
 * @RequirePermission(...) also need every listed permission.
 *
 * A request carrying `Authorization: Bearer nolag_...` is the staff AI assistant acting for a
 * user (agent-auth). That header wins over the session cookie and over @Public(): the request is
 * authenticated by the token only, may only GET routes marked @AgentReadable(), and every attempt
 * with a known token (expired, revoked or refused ones included) is logged with the user and the
 * agent.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets);
    if (isAgentAuthorization(request.headers.authorization)) {
      return this.authorizeAgent(request, required, targets);
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const user = token ? await this.auth.resolveSession(token) : null;
    if (!user) throw new UnauthorizedException('Not signed in');
    request.authUser = user;

    if (required?.some((permission) => !user.permissions.has(permission))) {
      throw new ForbiddenException('Missing permission');
    }
    return true;
  }

  private async authorizeAgent(
    request: AuthenticatedRequest,
    required: Permission[] | undefined,
    targets: Parameters<Reflector['getAllAndOverride']>[1],
  ): Promise<boolean> {
    const token = readAgentToken(request.headers.authorization);
    // A malformed or unknown token belongs to no user or agent: refused, with nothing to log.
    const resolved = token ? await this.auth.resolveAgentToken(token) : null;
    if (!resolved) throw new UnauthorizedException('Not signed in');
    const { tokenId, user } = resolved;
    // @Public() routes too: only GET routes marked @AgentReadable() are open to the assistant.
    const readable =
      request.method === 'GET' &&
      this.reflector.getAllAndOverride<boolean>(AGENT_READABLE, targets) === true;
    const permitted =
      user !== null && !required?.some((permission) => !user.permissions.has(permission));
    await this.auth.recordAgentAccess(
      tokenId,
      request.method,
      routePattern(request),
      readable && permitted,
    );
    if (!user) throw new UnauthorizedException('Not signed in');
    if (!readable) throw new ForbiddenException('Not available to the assistant');
    if (!permitted) throw new ForbiddenException('Missing permission');
    request.authUser = user;
    return true;
  }
}

/** The matched route pattern (e.g. /api/v1/shipments/:id), never the path with its values. */
function routePattern(request: AuthenticatedRequest): string {
  const route = (request as { route?: { path?: unknown } }).route;
  return typeof route?.path === 'string' ? route.path.slice(0, 200) : 'unknown';
}
