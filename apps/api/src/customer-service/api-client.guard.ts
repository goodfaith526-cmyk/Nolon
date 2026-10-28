import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CS_SCOPES, type CsScope } from '@nolon/shared';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { keyMatches, readApiKey } from './api-key.js';
import { API_SCOPE_KEY, keyScopes } from './api-scopes.js';

/** The Customer Service API client a request authenticated as. */
export interface ApiClientAuth {
  id: string;
  name: string;
  /** The only branches whose customers this key reads. */
  allowedBranchIds: readonly string[];
  /** What the key may do (CS_SCOPES). */
  scopes: readonly CsScope[];
}

interface ApiClientRequest extends Request {
  apiClient?: ApiClientAuth;
}

/** lastUsedAt is written at most once a minute per key. */
const LAST_USED_EVERY_MS = 60_000;

/**
 * Authenticates Customer Service API requests by their API key (never by a staff session: the
 * routes are @Public() for the session guard). Any failure to authenticate is the same 401. The
 * route's scope (@RequireApiScope) must be one the key holds, else 403 SCOPE_REQUIRED; a route
 * that names no scope is refused for every key (fails closed).
 */
@Injectable()
export class ApiClientGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const needed = this.reflector.getAllAndOverride<CsScope | undefined>(API_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!needed) throw new InternalServerErrorException('This route names no API scope');
    const request = context.switchToHttp().getRequest<ApiClientRequest>();
    const presented = readApiKey(request.headers.authorization);
    const client = presented
      ? await this.prisma.apiClient.findUnique({
          where: { keyPrefix: presented.prefix },
          include: {
            branches: { select: { branchId: true } },
            scopes: { select: { scope: true } },
          },
        })
      : null;
    if (!presented || !client || !client.isActive || !keyMatches(presented.key, client.keyHash)) {
      throw new UnauthorizedException('A valid Customer Service API key is required');
    }
    const scopes = keyScopes(client.customersRead, client.scopes, CS_SCOPES);
    if (!scopes.includes(needed)) {
      throw new ForbiddenException({
        message: `This API key does not hold the scope ${needed}`,
        code: 'SCOPE_REQUIRED',
        error: 'Forbidden',
        statusCode: 403,
      });
    }
    const now = new Date();
    if (!client.lastUsedAt || now.getTime() - client.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
      await this.prisma.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: now } });
    }
    request.apiClient = {
      id: client.id,
      name: client.name,
      allowedBranchIds: client.branches.map((b) => b.branchId),
      scopes,
    };
    return true;
  }
}

/** The API client the guard attached. Only on routes behind ApiClientGuard. */
export const CurrentApiClient = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const client = ctx.switchToHttp().getRequest<ApiClientRequest>().apiClient;
  if (!client) throw new InternalServerErrorException('No API client on this route');
  return client;
});
