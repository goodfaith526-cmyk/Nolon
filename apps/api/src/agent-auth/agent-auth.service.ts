import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AgentAuthorizeRequest,
  AgentAuthorizeResponse,
  AgentClientCreatedDto,
  AgentClientCreateRequest,
  AgentClientDto,
  AgentRevokeRequest,
  AgentTokenRequest,
  AgentTokenResponse,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { credentialStamp, lockCredentials } from '../auth/credential-lock.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  isAllowedRedirectUri,
  isAuthCodeShape,
  isAgentTokenShape,
  newAgentToken,
  newAuthCode,
  newClientId,
  newClientSecret,
  pkceMatches,
  secretMatches,
  sha256Hex,
} from './agent-secrets.js';

/** A one-time code is good for this long, and only once. */
export const AUTH_CODE_TTL_MS = 60_000;

/** Any failed exchange: one answer, whatever the reason, so nothing can be probed. */
export class InvalidGrantError extends BadRequestException {
  constructor() {
    super('Invalid grant');
  }
}

const clientInclude = { createdBy: { select: { fullName: true } } } as const;

/**
 * Delegated sign-in for the staff AI assistant (see agent-auth in @nolon/shared). A signed-in
 * staff member gets a one-time code (60 s, PKCE S256, sent only to the client's registered
 * redirect URI); the platform exchanges it server to server for a token of AGENT_TOKEN_TTL_MINUTES.
 * The token is bound to the staff session it came from: signing out, a password change or
 * deactivation ends it at once. There are no refresh tokens: the platform sends the user back
 * through /agent/authorize while their NOLON session lasts. Issue, exchange and revocation all
 * lock the user row first (see revokeAgentAccess).
 */
@Injectable()
export class AgentAuthService {
  private readonly logger = new Logger(AgentAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async authorize(user: AuthUser, input: AgentAuthorizeRequest): Promise<AgentAuthorizeResponse> {
    // The assistant cannot mint codes for itself (the guard keeps it off POST routes as well).
    if (user.agent) throw new ForbiddenException('Not available to the assistant');
    const client = await this.prisma.agentClient.findUnique({
      where: { clientId: input.clientId },
    });
    // Never redirect to an unregistered address: an unknown client or URI is an error page.
    if (!client?.isActive || client.redirectUri !== input.redirectUri) {
      throw new BadRequestException('Unknown assistant or redirect address');
    }
    const code = newAuthCode();
    // Lock order everywhere: user row, then codes and tokens (see revokeAgentAccess). Under the
    // user lock, a password change or reset has either committed (the stamp no longer matches
    // and nothing is issued) or waits for this code and then spends it.
    const issued = await this.prisma.$transaction(async (tx) => {
      const current = await lockCredentials(tx, user.id);
      if (!current?.isActive) return 'signed_out' as const;
      if (credentialStamp(current.passwordHash) !== user.credentialStamp) return 'stale' as const;
      const session = await tx.session.findUnique({
        where: { id: user.sessionId },
        select: { revokedAt: true, expiresAt: true },
      });
      // Both ends from one clock: the database refuses a code that lives longer than 60 seconds.
      const now = new Date();
      if (!session || session.revokedAt !== null || session.expiresAt <= now) {
        return 'signed_out' as const;
      }
      await tx.agentAuthCode.create({
        data: {
          codeHash: sha256Hex(code),
          agentClientId: client.id,
          userId: user.id,
          sessionId: user.sessionId,
          codeChallenge: input.codeChallenge,
          createdAt: now,
          expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS),
        },
      });
      return 'issued' as const;
    });
    if (issued === 'signed_out') throw new UnauthorizedException('Sign in again');
    if (issued === 'stale') {
      throw new ConflictException('Your password changed during the request; try again');
    }
    const target = new URL(client.redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', input.state);
    return { redirectTo: target.toString() };
  }

  /**
   * Exchanges a code for a token. The code is claimed (used_at) and the token created in one
   * transaction, so of two concurrent exchanges exactly one wins. Presenting a code a second time
   * revokes the token it produced (RFC 6749 section 4.1.2: the code may have leaked).
   */
  async exchange(input: AgentTokenRequest): Promise<AgentTokenResponse> {
    const client = await this.authenticateClient(input.clientId, input.clientSecret);
    if (!isAuthCodeShape(input.code)) throw new InvalidGrantError();
    const codeHash = sha256Hex(input.code);
    const ttlMs = this.env.AGENT_TOKEN_TTL_MINUTES * 60_000;
    const token = newAgentToken();

    const outcome = await this.prisma.$transaction(async (tx) => {
      const owner = await tx.agentAuthCode.findUnique({
        where: { codeHash },
        select: { userId: true, agentClientId: true },
      });
      if (!owner || owner.agentClientId !== client.id) return { ok: false as const };
      // User row first, then the code (the order of revokeAgentAccess): a password change or
      // reset either spent this code before we got here, or waits and revokes the token we create.
      await lockCredentials(tx, owner.userId);
      const code = await tx.agentAuthCode.findUnique({
        where: { codeHash },
        include: {
          session: { select: { revokedAt: true, expiresAt: true } },
          user: { select: { isActive: true } },
        },
      });
      if (!code || code.agentClientId !== client.id) return { ok: false as const };
      const claimed = await tx.agentAuthCode.updateMany({
        where: { id: code.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) return { ok: false as const, reusedCodeId: code.id };

      const now = new Date();
      const valid =
        code.expiresAt > now &&
        input.redirectUri === client.redirectUri &&
        pkceMatches(input.codeVerifier, code.codeChallenge) &&
        code.session.revokedAt === null &&
        code.session.expiresAt > now &&
        code.user.isActive;
      // The code is spent either way: a wrong verifier cannot be retried.
      if (!valid) return { ok: false as const };

      const row = await tx.agentToken.create({
        data: {
          tokenHash: sha256Hex(token),
          agentClientId: client.id,
          userId: code.userId,
          sessionId: code.sessionId,
          authCodeId: code.id,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        },
      });
      return { ok: true as const, row };
    });

    if (!outcome.ok) {
      if (outcome.reusedCodeId) {
        const { count } = await this.prisma.agentToken.updateMany({
          where: { authCodeId: outcome.reusedCodeId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.logger.warn(`Assistant code presented twice; revoked ${count} token(s)`);
      }
      throw new InvalidGrantError();
    }
    const { row } = outcome;
    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn: Math.round((row.expiresAt.getTime() - row.issuedAt.getTime()) / 1000),
      jti: row.id,
      subject: row.userId,
      tenant: client.tenant,
      audience: client.audience,
      issuedAt: row.issuedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /** RFC 7009: revokes the client's own token if it exists; says nothing either way. */
  async revoke(input: AgentRevokeRequest): Promise<void> {
    const client = await this.authenticateClient(input.clientId, input.clientSecret);
    if (!isAgentTokenShape(input.token)) return;
    await this.prisma.agentToken.updateMany({
      where: { tokenHash: sha256Hex(input.token), agentClientId: client.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listClients(): Promise<AgentClientDto[]> {
    const rows = await this.prisma.agentClient.findMany({
      include: clientInclude,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toDto);
  }

  async createClient(
    user: AuthUser,
    input: AgentClientCreateRequest,
  ): Promise<AgentClientCreatedDto> {
    if (!isAllowedRedirectUri(input.redirectUri, this.env.NODE_ENV !== 'production')) {
      throw new BadRequestException(['redirectUri']);
    }
    const clientSecret = newClientSecret();
    const row = await this.prisma.agentClient.create({
      data: {
        name: input.name,
        clientId: newClientId(),
        secretHash: sha256Hex(clientSecret),
        redirectUri: input.redirectUri,
        audience: input.audience,
        tenant: input.tenant,
        createdById: user.id,
      },
      include: clientInclude,
    });
    return { client: toDto(row), clientSecret };
  }

  /** Ends the client and, with it, every token it holds (the guard checks the client too). */
  async revokeClient(user: AuthUser, id: string): Promise<AgentClientDto> {
    const now = new Date();
    const count = await this.prisma.$transaction(async (tx) => {
      const done = await tx.agentClient.updateMany({
        where: { id, isActive: true },
        data: { isActive: false, revokedAt: now, revokedById: user.id },
      });
      await tx.agentToken.updateMany({
        where: { agentClientId: id, revokedAt: null },
        data: { revokedAt: now },
      });
      return done.count;
    });
    const row = await this.prisma.agentClient.findUnique({ where: { id }, include: clientInclude });
    if (!row) throw new NotFoundException('Assistant not found');
    if (count === 0) throw new ConflictException('The assistant is already revoked');
    return toDto(row);
  }

  private async authenticateClient(clientId: string, secret: string) {
    const client = await this.prisma.agentClient.findUnique({ where: { clientId } });
    if (!client?.isActive || !secretMatches(secret, client.secretHash)) {
      throw new UnauthorizedException('Invalid client');
    }
    return client;
  }
}

/**
 * Revokes every assistant token of the user and spends their unused codes. Call it inside the
 * transaction that changes or resets the password: a token must not outlive the credentials of
 * the user it acts for, even when the session it came from stays signed in.
 *
 * Lock order, the same in code issue, code exchange, password change and reset: the user row
 * (lockCredentials, a no-op when the caller already holds it), then codes, then tokens. Issue
 * and exchange take the user lock before touching codes, so each of them either commits before
 * this runs (and its code or token is revoked here) or runs after it and finds the new
 * credentials (issue refuses a stale request; exchange finds its code spent).
 */
export async function revokeAgentAccess(tx: Prisma.TransactionClient, userId: string) {
  await lockCredentials(tx, userId);
  await tx.agentAuthCode.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  await tx.agentToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

function toDto(row: {
  id: string;
  name: string;
  clientId: string;
  redirectUri: string;
  audience: string;
  tenant: string;
  isActive: boolean;
  createdAt: Date;
  revokedAt: Date | null;
  createdBy: { fullName: string };
}): AgentClientDto {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    audience: row.audience,
    tenant: row.tenant,
    isActive: row.isActive,
    createdByName: row.createdBy.fullName,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
