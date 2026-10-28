import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { CS_SCOPES, type CsAccessLevel } from '@nolon/shared';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ApiClientAuth } from './api-client.guard.js';
import { hashApiKey } from './api-key.js';
import { keyScopes } from './api-scopes.js';
import {
  CustomerTokensService,
  grantVersion,
  readCustomerToken,
  sha256,
} from './customer-tokens.service.js';

/** The customer a request's token is for, and the key that asked for it. */
export interface CustomerTokenAuth {
  tokenId: string;
  client: ApiClientAuth;
  customerId: string;
  customerNumber: string;
  level: CsAccessLevel;
}

interface TokenRequest extends Request {
  customerToken?: CustomerTokenAuth;
}

function refused(code: 'TOKEN_EXPIRED' | 'GRANT_REVOKED'): UnauthorizedException {
  return new UnauthorizedException({
    message: code === 'TOKEN_EXPIRED' ? 'The token expired' : 'The token is no longer valid',
    code,
    error: 'Unauthorized',
    statusCode: 401,
  });
}

/**
 * Authenticates /cs/me requests by a customer token (N2), and rechecks everything the token was
 * issued on, on every request (nothing is cached): the key is active, still holds
 * cs:customer_tokens:issue and still serves the customer's branch; the customer is active; the
 * phone still matches the same record (the customer's phone or WhatsApp, or the same authorized
 * person, active and allowed to inquire); and that record has not changed since (grantVersion).
 * An unknown token is a plain 401; an expired one TOKEN_EXPIRED; any other change GRANT_REVOKED.
 */
@Injectable()
export class CustomerTokenGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: CustomerTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TokenRequest>();
    const presented = readCustomerToken(request.headers.authorization);
    const row = presented
      ? await this.prisma.csCustomerToken.findUnique({
          where: { tokenHash: hashApiKey(presented) },
          include: {
            apiClient: {
              include: {
                branches: { select: { branchId: true } },
                scopes: { select: { scope: true } },
              },
            },
            customer: {
              select: {
                id: true,
                number: true,
                branchId: true,
                isActive: true,
                phone: true,
                whatsapp: true,
                updatedAt: true,
              },
            },
            contact: {
              select: {
                customerId: true,
                phone: true,
                isActive: true,
                canInquire: true,
                updatedAt: true,
              },
            },
          },
        })
      : null;
    if (!row) throw new UnauthorizedException('A valid customer token is required');
    const route = `${request.method} ${routeOf(request)}`;
    const reject = async (code: 'TOKEN_EXPIRED' | 'GRANT_REVOKED') => {
      await this.tokens.record(
        row.apiClientId,
        row.id,
        row.customerId,
        code === 'TOKEN_EXPIRED' ? 'EXPIRED' : 'REVOKED',
        route,
      );
      return refused(code);
    };
    if (row.expiresAt.getTime() <= Date.now()) throw await reject('TOKEN_EXPIRED');

    const key = row.apiClient;
    const branchIds = key.branches.map((b) => b.branchId);
    const scopes = keyScopes(key.customersRead, key.scopes, CS_SCOPES);
    const { customer, contact } = row;
    const matched =
      row.grantKind === 'CUSTOMER_PHONE'
        ? sha256(customer.phone) === row.phoneHash
        : row.grantKind === 'CUSTOMER_WHATSAPP'
          ? customer.whatsapp !== null && sha256(customer.whatsapp) === row.phoneHash
          : contact !== null &&
            contact.customerId === customer.id &&
            contact.isActive &&
            contact.canInquire &&
            sha256(contact.phone) === row.phoneHash;
    const version = grantVersion(
      customer.updatedAt,
      row.grantKind === 'CONTACT_PHONE' ? (contact?.updatedAt ?? null) : null,
    );
    if (
      !key.isActive ||
      !scopes.includes('cs:customer_tokens:issue') ||
      !branchIds.includes(customer.branchId) ||
      !customer.isActive ||
      !matched ||
      BigInt(version) !== row.grantVersion
    ) {
      throw await reject('GRANT_REVOKED');
    }
    request.customerToken = {
      tokenId: row.id,
      client: { id: key.id, name: key.name, allowedBranchIds: branchIds, scopes },
      customerId: customer.id,
      customerNumber: customer.number,
      level: row.level,
    };
    return true;
  }
}

/** The route pattern (never the values in it). */
function routeOf(request: Request): string {
  const path = (request.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? path.slice(0, 80) : 'unknown';
}

export const CurrentCustomerToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const token = ctx.switchToHttp().getRequest<TokenRequest>().customerToken;
    if (!token) throw new InternalServerErrorException('No customer token on this route');
    return token;
  },
);
