import { Inject, Injectable, Logger } from '@nestjs/common';
import { hasAllBranchAccess, type AuthMeResponse, type Role } from '@nolon/shared';
import { loadAccess, readAccessVersion } from '../access-control/access-loader.js';
import { revokeAgentAccess } from '../agent-auth/agent-auth.service.js';
import { sha256Hex } from '../agent-auth/agent-secrets.js';
import { todayIn } from '../common/dates.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth-user.js';
import { credentialStamp, lockCredentials } from './credential-lock.js';
import { normalizeEmail } from './email.js';
import { EMAIL_RULE, FailureLimiter, IP_RULE } from './login-rate-limiter.js';
import { hashPassword, timingDummyHash, verifyPassword } from './password.js';
import { hashSessionToken, newSessionToken } from './session-token.js';

export type LoginResult =
  { ok: true; token: string; expiresAt: Date } | { ok: false; reason: 'invalid' | 'rate_limited' };

export interface LoginContext {
  ip: string | undefined;
  userAgent: string | undefined;
}

const USER_ACCESS = {
  roles: true,
  branches: { select: { branchId: true } },
  // Outlet Staff (plan 4.2): only active sales outlets count.
  outlets: {
    where: { partner: { isActive: true, kind: 'SALES_OUTLET' } },
    select: { partnerId: true, partner: { select: { branchId: true } } },
  },
} as const;

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

    const issued = await this.issueSession(user.id, user.passwordHash, ctx);
    if (!issued) {
      // The password was reset or the account deactivated between the check and now.
      this.logger.warn(`Sign-in for ${normalized} lost a race with a credential change`);
      return { ok: false, reason: 'invalid' };
    }
    this.emailLimiter.reset(emailKey);
    return { ok: true, ...issued };
  }

  /**
   * Creates a session only if the user is still active and still has the password hash that was
   * verified (`verifiedHash`), checked under the user row lock. A concurrent password reset or
   * deactivation either commits first (and this returns null) or waits for this transaction and
   * then revokes the new session with the others.
   */
  async issueSession(
    userId: string,
    verifiedHash: string,
    ctx: LoginContext,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + this.env.SESSION_TTL_HOURS * 60 * 60 * 1000);
    const created = await this.prisma.$transaction(async (tx) => {
      const current = await lockCredentials(tx, userId);
      if (!current?.isActive || current.passwordHash !== verifiedHash) return false;
      await tx.session.create({
        data: {
          userId,
          tokenHash: hashSessionToken(token),
          expiresAt,
          ipAddress: ctx.ip?.slice(0, 45) ?? null,
          userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        },
      });
      await tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
      return true;
    });
    return created ? { token, expiresAt } : null;
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
    // First, before the session and user snapshot (F118-1): see readAccessVersion.
    const version = await readAccessVersion(this.prisma);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: { include: USER_ACCESS } },
    });
    const now = new Date();
    if (!session || session.revokedAt !== null || session.expiresAt <= now) return null;
    if (!session.user.isActive) return null;

    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    return this.toAuthUser(session.user, session.id, version);
  }

  /**
   * The staff member a delegated assistant token acts for (agent-auth), rebuilt from the database
   * on every request like a session. Null for an unknown token. For a known token, `user` is null
   * unless it is unexpired and unrevoked, its client is active, the staff session it came from is
   * still valid and the user is active; `tokenId` is returned either way so the attempt can be
   * logged. The user's current roles and branches apply, never more.
   */
  async resolveAgentToken(
    token: string,
  ): Promise<{ tokenId: string; user: AuthUser | null } | null> {
    // First, before the token and user snapshot (F118-1): see readAccessVersion.
    const version = await readAccessVersion(this.prisma);
    const row = await this.prisma.agentToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: {
        agentClient: { select: { clientId: true, isActive: true } },
        session: { select: { revokedAt: true, expiresAt: true } },
        user: { include: USER_ACCESS },
      },
    });
    if (!row) return null;
    const now = new Date();
    const valid =
      row.revokedAt === null &&
      row.expiresAt > now &&
      row.agentClient.isActive &&
      row.session.revokedAt === null &&
      row.session.expiresAt > now &&
      row.user.isActive;
    if (!valid) return { tokenId: row.id, user: null };
    const user = await this.toAuthUser(row.user, row.sessionId, version);
    return {
      tokenId: row.id,
      user: { ...user, agent: { clientId: row.agentClient.clientId, tokenId: row.id } },
    };
  }

  /**
   * One append-only row per assistant request with a known token, refused ones included: the real
   * user and the agent together, both taken from the token row.
   */
  async recordAgentAccess(
    tokenId: string,
    method: string,
    route: string,
    allowed: boolean,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "agent_access_events"
        ("agent_token_id", "agent_client_id", "user_id", "method", "route", "allowed")
      SELECT t."id", t."agent_client_id", t."user_id", ${method.slice(0, 10)}, ${route}, ${allowed}
      FROM "agent_tokens" t WHERE t."id" = ${tokenId}::uuid`;
  }

  private async toAuthUser(
    user: {
      id: string;
      email: string;
      fullName: string;
      preferredLocale: string;
      passwordHash: string;
      roles: { role: Role }[];
      branches: { branchId: string }[];
      outlets: { partnerId: string; partner: { branchId: string } }[];
    },
    sessionId: string,
    /** access_state.version, read before `user` was loaded. */
    version: string,
  ): Promise<AuthUser> {
    const roles: Role[] = user.roles.map((r) => r.role);
    const allBranches = hasAllBranchAccess(roles);
    const access = await loadAccess(
      this.prisma,
      user.id,
      roles,
      user.branches.map((b) => b.branchId),
      version,
    );
    const allowedBranchIds = access.branchIds();
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      preferredLocale: user.preferredLocale,
      sessionId,
      credentialStamp: credentialStamp(user.passwordHash),
      roles,
      access,
      allBranches,
      allowedBranchIds,
      // Any Outlet Staff role limits the user to their outlets, whatever else they hold, and only
      // to outlets of their own branches.
      allowedOutletIds: roles.includes('OUTLET_STAFF')
        ? user.outlets
            .filter((o) => allowedBranchIds.includes(o.partner.branchId))
            .map((o) => o.partnerId)
        : null,
    };
  }

  /**
   * The signed-in user changes their own password. Other sessions of the user end; this one
   * stays signed in.
   */
  async changePassword(
    user: AuthUser,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(currentPassword, row.passwordHash))) return false;
    return this.applyPasswordChange(user, row.passwordHash, await hashPassword(newPassword));
  }

  /**
   * Writes the new hash only if the stored hash is still the one the current password was checked
   * against (compare-and-set under the user row lock), so a concurrent admin reset is never
   * overwritten. Ends the user's other sessions and every assistant token and unused code of the
   * user (including those issued from this session) in the same transaction.
   */
  async applyPasswordChange(
    user: AuthUser,
    verifiedHash: string,
    newHash: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const current = await lockCredentials(tx, user.id);
      if (!current?.isActive || current.passwordHash !== verifiedHash) return false;
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: user.sessionId } },
        data: { revokedAt: new Date() },
      });
      await revokeAgentAccess(tx, user.id);
      return true;
    });
  }

  async describe(user: AuthUser, now: Date = new Date()): Promise<AuthMeResponse> {
    const rows = await this.prisma.branch.findMany({
      where: { id: { in: [...user.allowedBranchIds] } },
      select: {
        id: true,
        code: true,
        nameEn: true,
        nameAr: true,
        timezone: true,
        defaultCurrency: true,
      },
      orderBy: { code: 'asc' },
    });
    const branches = rows.map((b) => ({ ...b, today: todayIn(b.timezone, now) }));
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      preferredLocale: user.preferredLocale,
      roles: user.roles,
      permissions: user.access.all(),
      allBranches: user.allBranches,
      branches,
      branchPermissions: branches.map((b) => ({
        branchId: b.id,
        permissions: user.access.inBranch(b.id),
      })),
      delegations: await this.liveDelegations(user),
      assistantUrl: this.env.AGENT_ASSISTANT_URL ?? null,
      assistantPanel: Boolean(this.env.AGENT_ASSISTANT_URL) && this.env.AGENT_ASSISTANT_PANEL,
    };
  }

  /** Plan 03: the delegations this person holds in a branch they still work in. */
  private async liveDelegations(user: AuthUser): Promise<{ id: string; branchId: string }[]> {
    const rows = await this.prisma.branchDelegation.findMany({
      where: {
        delegateUserId: user.id,
        revokedAt: null,
        delegate: { isActive: true },
      },
      select: { id: true, branchId: true },
      orderBy: { createdAt: 'asc' },
    });
    const member = await this.prisma.userBranch.findMany({
      where: { userId: user.id },
      select: { branchId: true },
    });
    const branches = new Set(member.map((m) => m.branchId));
    return rows.filter((d) => branches.has(d.branchId));
  }
}
