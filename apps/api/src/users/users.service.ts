import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  hasAllBranchAccess,
  type CreateUserRequest,
  type Role,
  type UpdateUserRequest,
  type UserSummary,
} from '@nolon/shared';
import { normalizeEmail } from '../auth/email.js';
import { lockCredentials } from '../auth/credential-lock.js';
import { hashPassword } from '../auth/password.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

const USER_INCLUDE = {
  roles: { select: { role: true } },
  branches: { select: { branchId: true } },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

function toSummary(user: UserRow): UserSummary {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    preferredLocale: user.preferredLocale,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    roles: user.roles.map((r) => r.role),
    branchIds: user.branches.map((b) => b.branchId).sort(),
  };
}

/**
 * Staff user administration (Administrator only, enforced by the controller's permissions).
 * Users are never deleted, only deactivated. Rules that protect access live here:
 * - a role that is not all-branch needs at least one branch,
 * - there is always at least one active Administrator,
 * - an administrator cannot deactivate themselves,
 * - deactivation and password reset end the user's open sessions.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<UserSummary[]> {
    const users = await this.prisma.user.findMany({
      include: USER_INCLUDE,
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
    });
    return users.map(toSummary);
  }

  async create(input: CreateUserRequest): Promise<UserSummary> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    return this.prisma.$transaction(async (tx) => {
      assertBranchesForRoles(input.roles, input.branchIds);
      await assertBranchesExist(tx, input.branchIds);
      if (await tx.user.findUnique({ where: { email } })) {
        throw new ConflictException('A user with this email already exists');
      }
      const user = await tx.user.create({
        data: {
          email,
          fullName: input.fullName.trim(),
          passwordHash,
          preferredLocale: input.preferredLocale,
          roles: { create: unique(input.roles).map((role) => ({ role })) },
          branches: { create: unique(input.branchIds).map((branchId) => ({ branchId })) },
        },
        include: USER_INCLUDE,
      });
      return toSummary(user);
    });
  }

  async update(id: string, input: UpdateUserRequest): Promise<UserSummary> {
    return this.prisma.$transaction(async (tx) => {
      await lockAdministratorSet(tx);
      const current = await findOrThrow(tx, id);
      const roles = input.roles ?? current.roles.map((r) => r.role);
      const branchIds = input.branchIds ?? current.branches.map((b) => b.branchId);
      assertBranchesForRoles(roles, branchIds);
      if (input.branchIds) await assertBranchesExist(tx, input.branchIds);

      if (input.roles) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({
          data: unique(input.roles).map((role) => ({ userId: id, role })),
        });
      }
      if (input.branchIds) {
        await tx.userBranch.deleteMany({ where: { userId: id } });
        await tx.userBranch.createMany({
          data: unique(input.branchIds).map((branchId) => ({ userId: id, branchId })),
        });
      }
      await tx.user.update({
        where: { id },
        data: {
          ...(input.fullName !== undefined && { fullName: input.fullName.trim() }),
          ...(input.preferredLocale !== undefined && { preferredLocale: input.preferredLocale }),
        },
      });
      await assertActiveAdministratorRemains(tx);
      return toSummary(await findOrThrow(tx, id));
    });
  }

  async setActive(actorId: string, id: string, isActive: boolean): Promise<UserSummary> {
    if (!isActive && actorId === id) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    return this.prisma.$transaction(async (tx) => {
      await lockAdministratorSet(tx);
      if (!(await lockCredentials(tx, id))) throw new NotFoundException('User not found');
      await tx.user.update({ where: { id }, data: { isActive } });
      if (!isActive) {
        await revokeSessions(tx, id);
        await assertActiveAdministratorRemains(tx);
      }
      return toSummary(await findOrThrow(tx, id));
    });
  }

  /** Admin reset: sets a new password and ends every open session of that user. */
  async resetPassword(id: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockCredentials(tx, id))) throw new NotFoundException('User not found');
      await tx.user.update({ where: { id }, data: { passwordHash } });
      await revokeSessions(tx, id);
    });
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

async function findOrThrow(tx: Tx, id: string): Promise<UserRow> {
  const user = await tx.user.findUnique({ where: { id }, include: USER_INCLUDE });
  if (!user) throw new NotFoundException('User not found');
  return user;
}

function assertBranchesForRoles(roles: readonly Role[], branchIds: readonly string[]): void {
  if (roles.length === 0) throw new BadRequestException('A user needs at least one role');
  if (!hasAllBranchAccess(roles) && branchIds.length === 0) {
    throw new BadRequestException('This role needs at least one branch');
  }
}

async function assertBranchesExist(tx: Tx, branchIds: readonly string[]): Promise<void> {
  const ids = unique(branchIds);
  const found = await tx.branch.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw new BadRequestException('Unknown branch');
}

/**
 * Serializes every change that can remove an active Administrator (role change, deactivation).
 * Without it, two concurrent READ COMMITTED transactions could each demote a different admin,
 * each still counting the other, and leave none. Transaction-scoped: released at commit/rollback.
 */
const ADMIN_SET_LOCK_KEY = 74_201_001;

async function lockAdministratorSet(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_SET_LOCK_KEY})`;
}

async function assertActiveAdministratorRemains(tx: Tx): Promise<void> {
  const admins = await tx.user.count({
    where: { isActive: true, roles: { some: { role: 'ADMINISTRATOR' } } },
  });
  if (admins === 0) {
    throw new ConflictException('There must always be at least one active Administrator');
  }
}

export async function revokeSessions(tx: Tx, userId: string, exceptSessionId?: string) {
  await tx.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId !== undefined && { id: { not: exceptSessionId } }),
    },
    data: { revokedAt: new Date() },
  });
}
