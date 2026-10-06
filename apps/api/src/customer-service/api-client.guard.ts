import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { keyMatches, readApiKey } from './api-key.js';

/** The Customer Service API client a request authenticated as. */
export interface ApiClientAuth {
  id: string;
  name: string;
  /** The only branches whose customers this key reads. */
  allowedBranchIds: readonly string[];
}

interface ApiClientRequest extends Request {
  apiClient?: ApiClientAuth;
}

/** lastUsedAt is written at most once a minute per key. */
const LAST_USED_EVERY_MS = 60_000;

/**
 * Authenticates Customer Service API requests by their API key (never by a staff session: the
 * routes are @Public() for the session guard). Any failure is the same 401.
 */
@Injectable()
export class ApiClientGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiClientRequest>();
    const presented = readApiKey(request.headers.authorization);
    const client = presented
      ? await this.prisma.apiClient.findUnique({
          where: { keyPrefix: presented.prefix },
          include: { branches: { select: { branchId: true } } },
        })
      : null;
    if (!presented || !client || !client.isActive || !keyMatches(presented.key, client.keyHash)) {
      throw new UnauthorizedException('A valid Customer Service API key is required');
    }
    const now = new Date();
    if (!client.lastUsedAt || now.getTime() - client.lastUsedAt.getTime() > LAST_USED_EVERY_MS) {
      await this.prisma.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: now } });
    }
    request.apiClient = {
      id: client.id,
      name: client.name,
      allowedBranchIds: client.branches.map((b) => b.branchId),
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
