import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type ApiClientCreatedDto,
  type ApiClientCreateRequest,
  type ApiClientDto,
  CS_REQUEST_SERVICES,
  CS_SCOPES,
  type CsRequestService,
  type CsScope,
} from '@nolon/shared';
import { AuditService, changedFields } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess } from '../auth/branch-scope.js';
import type { ApiScope, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { newApiKey } from './api-key.js';
import { keyScopes, keyServices, scopeRows } from './api-scopes.js';

const include = {
  branches: { include: { branch: { select: { code: true } } } },
  scopes: { select: { scope: true } },
  createdBy: { select: { fullName: true } },
} as const;

type Row = Prisma.ApiClientGetPayload<{ include: typeof include }>;

/**
 * Customer Service API keys, managed by the Administrator (who manages user accounts). A key is
 * shown once when it is made; it can be revoked, not changed or shown again, except for its
 * scopes (what it may do). Making a key, changing its scopes and revoking it are in the audit log.
 */
@Injectable()
export class ApiClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
    const scopes = ordered(input.scopes);
    const { key, prefix, hash } = newApiKey();
    const row = await this.prisma.$transaction(async (tx) => {
      const made = await tx.apiClient.create({
        data: {
          name: input.name,
          keyPrefix: prefix,
          keyHash: hash,
          createdById: user.id,
          // Always explicit: the column's default (true) is only for the keys made before scopes.
          customersRead: scopes.includes('cs:customers:read'),
          ...serviceColumns(input.services ?? CS_REQUEST_SERVICES),
          branches: { create: branchIds.map((branchId) => ({ branchId })) },
          scopes: { create: scopeRows(scopes).map((scope) => ({ scope, grantedById: user.id })) },
        },
        include,
      });
      const dto = toDto(made);
      await this.audit.record(tx, user, {
        branchId: null,
        entity: 'API_CLIENT',
        entityId: made.id,
        reference: reference(dto),
        action: 'CREATED',
        changes: changedFields(null, auditFields(dto), ['name', 'branches', 'scopes', 'services']),
      });
      return made;
    });
    return { client: toDto(row), key };
  }

  /** Replaces the scopes of an active key, for an Administrator of all its branches. */
  async setScopes(user: AuthUser, id: string, given: readonly CsScope[]): Promise<ApiClientDto> {
    const scopes = ordered(given);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "api_clients" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = await tx.apiClient.findUnique({ where: { id }, include });
      if (!before) throw new NotFoundException('API key not found');
      for (const b of before.branches) assertBranchAccess(user, b.branchId);
      if (!before.isActive) throw new ConflictException('The API key is revoked');
      const rows = scopeRows(scopes);
      await tx.apiClientScope.deleteMany({
        where: { apiClientId: id, scope: { notIn: rows } },
      });
      const held = new Set<ApiScope>(before.scopes.map((s) => s.scope));
      await tx.apiClientScope.createMany({
        data: rows
          .filter((scope) => !held.has(scope))
          .map((scope) => ({ apiClientId: id, scope, grantedById: user.id })),
      });
      const after = await tx.apiClient.update({
        where: { id },
        data: { customersRead: scopes.includes('cs:customers:read') },
        include,
      });
      const dto = toDto(after);
      await this.audit.record(tx, user, {
        branchId: null,
        entity: 'API_CLIENT',
        entityId: id,
        reference: reference(dto),
        action: 'UPDATED',
        changes: changedFields(auditFields(toDto(before)), auditFields(dto), ['scopes']),
      });
      return dto;
    });
  }

  /**
   * Sets the services an active key's bot offers (PICKUP, LAST_MILE), for an Administrator of all
   * its branches: its catalog lists only those, and its booking requests may ask only for those.
   */
  async setServices(
    user: AuthUser,
    id: string,
    services: readonly CsRequestService[],
  ): Promise<ApiClientDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "api_clients" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = await tx.apiClient.findUnique({ where: { id }, include });
      if (!before) throw new NotFoundException('API key not found');
      for (const b of before.branches) assertBranchAccess(user, b.branchId);
      if (!before.isActive) throw new ConflictException('The API key is revoked');
      const after = await tx.apiClient.update({
        where: { id },
        data: serviceColumns(services),
        include,
      });
      const dto = toDto(after);
      await this.audit.record(tx, user, {
        branchId: null,
        entity: 'API_CLIENT',
        entityId: id,
        reference: reference(dto),
        action: 'UPDATED',
        changes: changedFields(auditFields(toDto(before)), auditFields(dto), ['services']),
      });
      return dto;
    });
  }

  async revoke(user: AuthUser, id: string): Promise<ApiClientDto> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.apiClient.updateMany({
        where: { id, isActive: true },
        data: { isActive: false, revokedAt: new Date(), revokedById: user.id },
      });
      const row = await tx.apiClient.findUnique({ where: { id }, include });
      if (!row) throw new NotFoundException('API key not found');
      if (count === 0) throw new ConflictException('The API key is already revoked');
      const dto = toDto(row);
      await this.audit.record(tx, user, {
        branchId: null,
        entity: 'API_CLIENT',
        entityId: id,
        reference: reference(dto),
        action: 'CANCELLED',
        changes: [{ field: 'isActive', before: 'true', after: 'false' }],
      });
      return dto;
    });
  }
}

function ordered(scopes: readonly CsScope[]): CsScope[] {
  return CS_SCOPES.filter((s) => scopes.includes(s));
}

function reference(dto: ApiClientDto): string {
  return `${dto.name} (${dto.keyPrefix})`;
}

function auditFields(dto: ApiClientDto) {
  return { name: dto.name, branches: dto.branchCodes, scopes: dto.scopes, services: dto.services };
}

function serviceColumns(services: readonly CsRequestService[]) {
  return {
    offersPickup: services.includes('PICKUP'),
    offersLastMile: services.includes('LAST_MILE'),
  };
}

function toDto(row: Row): ApiClientDto {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: `nolcs_${row.keyPrefix}`,
    branchCodes: row.branches.map((b) => b.branch.code).sort(),
    scopes: keyScopes(row.customersRead, row.scopes, CS_SCOPES),
    services: keyServices(row),
    isActive: row.isActive,
    createdByName: row.createdBy.fullName,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
