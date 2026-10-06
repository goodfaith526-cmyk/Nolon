import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiClientCreatedDto, ApiClientCreateRequest, ApiClientDto } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess } from '../auth/branch-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { newApiKey } from './api-key.js';

const include = {
  branches: { include: { branch: { select: { code: true } } } },
  createdBy: { select: { fullName: true } },
} as const;

/**
 * Customer Service API keys, managed by the Administrator (who manages user accounts). A key is
 * shown once when it is made; it can be revoked, not changed or shown again.
 */
@Injectable()
export class ApiClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ApiClientDto[]> {
    const rows = await this.prisma.apiClient.findMany({
      include,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toDto);
  }

  async create(user: AuthUser, input: ApiClientCreateRequest): Promise<ApiClientCreatedDto> {
    const branchIds = [...new Set(input.branchIds)];
    for (const id of branchIds) assertBranchAccess(user, id);
    const { key, prefix, hash } = newApiKey();
    const row = await this.prisma.apiClient.create({
      data: {
        name: input.name,
        keyPrefix: prefix,
        keyHash: hash,
        createdById: user.id,
        branches: { create: branchIds.map((branchId) => ({ branchId })) },
      },
      include,
    });
    return { client: toDto(row), key };
  }

  async revoke(user: AuthUser, id: string): Promise<ApiClientDto> {
    const { count } = await this.prisma.apiClient.updateMany({
      where: { id, isActive: true },
      data: { isActive: false, revokedAt: new Date(), revokedById: user.id },
    });
    const row = await this.prisma.apiClient.findUnique({ where: { id }, include });
    if (!row) throw new NotFoundException('API key not found');
    if (count === 0) throw new ConflictException('The API key is already revoked');
    return toDto(row);
  }
}

function toDto(row: {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  branches: { branch: { code: string } }[];
  createdBy: { fullName: string };
}): ApiClientDto {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: `nolcs_${row.keyPrefix}`,
    branchCodes: row.branches.map((b) => b.branch.code).sort(),
    isActive: row.isActive,
    createdByName: row.createdBy.fullName,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
