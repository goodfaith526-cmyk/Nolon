import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@nolon/shared';
import { setRequestAccessVersion } from '../access-control/request-access.js';
import type { AuthUser, AuthenticatedRequest } from './auth-user.js';
import { AuthService } from './auth.service.js';
import { isAgentAuthorization, readAgentToken } from '../agent-auth/agent-secrets.js';
import {
  AGENT_DRAFT_CHECKABLE,
  AGENT_DRAFT_DECIDABLE,
  AGENT_DRAFT_WRITABLE,
  AGENT_READABLE,
  IS_PUBLIC,
  OUTLET_SCOPED,
  REQUIRED_PERMISSIONS,
} from './decorators.js';
import { outletLimited } from './outlet-scope.js';
import { SESSION_COOKIE, readCookie } from './session-token.js';

/**
 * Global guard: every route needs a valid session unless marked @Public(), and routes marked
 * @RequirePermission(...) also need every listed permission.
 *
 * A request carrying `Authorization: Bearer nolag_...` is the staff AI assistant acting for a
 * user (agent-auth). That header wins over the session cookie and over @Public(): the request is
 * authenticated by the token only, may only GET routes marked @AgentReadable() and POST the
 * draft routes marked @AgentDraftWritable() or @AgentDraftDecidable(), and every attempt
 * with a known token (expired, revoked or refused ones included) is logged with the user and the
 * agent.
 *
 * An Outlet Staff user (business model plan 4.2) reaches only routes marked @OutletScoped(), and
 * never through the assistant.
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
    const scoped = forRoute(user, required);
    setRequestAccessVersion(user.access.version);
    request.authUser = scoped ?? user;
    if (!scoped) throw new ForbiddenException('Missing permission');
    // Outlet Staff (plan 4.2): only routes built for the outlet filter.
    if (
      outletLimited(user) &&
      this.reflector.getAllAndOverride<boolean>(OUTLET_SCOPED, targets) !== true
    ) {
      throw new ForbiddenException('Not available to outlet staff');
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
    // @Public() routes too: only GET routes marked @AgentReadable(), and POST on the draft routes
    // marked @AgentDraftWritable(), @AgentDraftDecidable() or @AgentDraftCheckable(), are open to
    // the assistant.
    const marked = (key: string) =>
      this.reflector.getAllAndOverride<boolean>(key, targets) === true;
    const open =
      (request.method === 'GET' && marked(AGENT_READABLE)) ||
      (request.method === 'POST' &&
        (marked(AGENT_DRAFT_WRITABLE) ||
          marked(AGENT_DRAFT_DECIDABLE) ||
          marked(AGENT_DRAFT_CHECKABLE)));
    // Outlet Staff cannot use the assistant in this batch (plan 4.2 item 5).
    const scoped = user && !outletLimited(user) ? forRoute(user, required) : null;
    const permitted = scoped !== null;
    await this.auth.recordAgentAccess(
      tokenId,
      request.method,
      routePattern(request),
      open && permitted,
    );
    if (!user) throw new UnauthorizedException('Not signed in');
    if (!open) throw new ForbiddenException('Not available to the assistant');
    if (!scoped) throw new ForbiddenException('Missing permission');
    setRequestAccessVersion(user.access.version);
    request.authUser = scoped;
    return true;
  }
}

/**
 * The user as this route sees them (plan 03, section 5.2): null when they lack a required
 * permission in every branch; otherwise their branch list narrowed to the branches where they
 * hold every required permission, so `branchScope` and `listBranchScope` cover only those.
 * A route that needs a branch-owned permission held in no single branch is refused.
 */
export function forRoute(
  user: AuthUser,
  required: readonly Permission[] | undefined,
): AuthUser | null {
  if (!required || required.length === 0) return user;
  if (required.some((permission) => !user.access.any(permission))) return null;
  const branches = new Set(user.access.branchesWith(required));
  if (branches.size === 0) return null;
  return { ...user, allowedBranchIds: user.allowedBranchIds.filter((id) => branches.has(id)) };
}

/** The matched route pattern (e.g. /api/v1/shipments/:id), never the path with its values. */
function routePattern(request: AuthenticatedRequest): string {
  const route = (request as { route?: { path?: unknown } }).route;
  return typeof route?.path === 'string' ? route.path.slice(0, 200) : 'unknown';
}
