import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  hasAllBranchAccess,
  permissionsForRoles,
  type AuthMeResponse,
  type Role,
} from '@nolon/shared';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth-user.js';
import { normalizeEmail } from './email.js';
import { EMAIL_RULE, FailureLimiter, IP_RULE } from './login-rate-limiter.js';
import { timingDummyHash, verifyPassword } from './password.js';
import { hashSessionToken, newSessionToken } from './session-token.js';

export type LoginResult =
  { ok: true; token: string; expiresAt: Date } | { ok: false; reason: 'invalid' | 'rate_limited' };

export interface LoginContext {
  ip: string | undefined;
  userAgent: string | undefined;
}

// lastSeenAt is a hint for admins, not a security control: refresh it at most this often.
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly emailLimiter = new FailureLimiter(EMAIL_RULE);
  private readonly ipLimiter = new FailureLimiter(IP_RULE);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * Unknown email, wrong password and inactive user all return the same "invalid" result, after
   * the same amount of hashing work.
   */
  async login(email: string, password: string, ctx: LoginContext): Promise<LoginResult> {
    const normalized = normalizeEmail(email);
    const emailKey = `email:${normalized}`;
    const ipKey = this.env.LOGIN_IP_LIMIT_ENABLED && ctx.ip ? `ip:${ctx.ip}` : undefined;

    if (this.emailLimiter.isBlocked(emailKey) || (ipKey && this.ipLimiter.isBlocked(ipKey))) {
      return { ok: false, reason: 'rate_limited' };
    }

    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    const passwordOk = await verifyPassword(
      password,
      user?.passwordHash ?? (await timingDummyHash()),
    );

    if (!user || !user.isActive || !passwordOk) {
      this.emailLimiter.recordFailure(emailKey);
      if (ipKey) this.ipLimiter.recordFailure(ipKey);
      this.logger.warn(`Failed sign-in for ${normalized} from ${ctx.ip ?? 'unknown'}`);
      return { ok: false, reason: 'invalid' };
    }

    this.emailLimiter.reset(emailKey);
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + this.env.SESSION_TTL_HOURS * 60 * 60 * 1000);
    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: hashSessionToken(token),
          expiresAt,
          ipAddress: ctx.ip?.slice(0, 45) ?? null,
          userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        },
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    ]);
    return { ok: true, token, expiresAt };
  }

  /** Revokes the session behind this token, if any. Idempotent. */
  async logout(token: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Loads the session with its user, roles and branches. Returns null for an unknown, expired or
   * revoked session, or an inactive user. Runs on every authenticated request (plan S3).
   */
  async resolveSession(token: string): Promise<AuthUser | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: {
        user: {
          include: {
            roles: true,
            branches: { select: { branchId: true } },
          },
        },
      },
    });
    const now = new Date();
    if (!session || session.revokedAt !== null || session.expiresAt <= now) return null;
    const { user } = session;
    if (!user.isActive) return null;

    const roles: Role[] = user.roles.map((r) => r.role);
    const allBranches = hasAllBranchAccess(roles);
    const allowedBranchIds = allBranches
      ? (await this.prisma.branch.findMany({ select: { id: true } })).map((b) => b.id)
      : user.branches.map((b) => b.branchId);

    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      preferredLocale: user.preferredLocale,
      sessionId: session.id,
      roles,
      permissions: new Set(permissionsForRoles(roles)),
      allBranches,
      allowedBranchIds,
    };
  }

  async describe(user: AuthUser): Promise<AuthMeResponse> {
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: [...user.allowedBranchIds] } },
      select: { id: true, code: true, nameEn: true, nameAr: true },
      orderBy: { code: 'asc' },
    });
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      preferredLocale: user.preferredLocale,
      roles: user.roles,
      permissions: [...user.permissions].sort(),
      allBranches: user.allBranches,
      branches,
    };
  }
}
