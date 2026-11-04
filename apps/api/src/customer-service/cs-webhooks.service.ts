import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CS_OUTBOX_STATUSES,
  type CsOutboxStatus,
  type CsWebhookEndpointCreate,
  type CsWebhookEndpointDto,
  type CsWebhookEndpointStatus,
  type CsWebhookEventType,
  type CsWebhooksDto,
} from '@nolon/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess } from '../auth/branch-scope.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { checkEndpointUrl } from './webhook-delivery.js';

type Tx = Prisma.TransactionClient;

/** The notices the screen lists, newest first. */
const RECENT = 30;

const names = {
  createdBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
} as const;

type EndpointRow = Prisma.CsWebhookEndpointGetPayload<{ include: typeof names }>;

/**
 * Plan 09 section 5: where a key's bot receives notices, kept by the Administrator (who keeps the
 * keys). One person adds an endpoint, another approves it (as payment instructions); approving
 * retires the key's approved one in the same transaction, under the key's lock. Each change is in
 * the audit log under the key.
 */
@Injectable()
export class CsWebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async view(user: AuthUser, apiClientId: string): Promise<CsWebhooksDto> {
    const key = await this.prisma.apiClient.findUnique({
      where: { id: apiClientId },
      select: { id: true },
    });
    if (!key) throw new NotFoundException('API key not found');
    const [endpoints, grouped, recent] = await Promise.all([
      this.prisma.csWebhookEndpoint.findMany({
        where: { apiClientId },
        include: names,
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.csOutboxEvent.groupBy({
        by: ['status'],
        where: { apiClientId },
        _count: { _all: true },
      }),
      this.prisma.csOutboxEvent.findMany({
        where: { apiClientId },
        include: { request: { select: { reference: true } } },
        orderBy: [{ createdAt: 'desc' }, { sequence: 'desc' }],
        take: RECENT,
      }),
    ]);
    const counts = Object.fromEntries(CS_OUTBOX_STATUSES.map((s) => [s, 0])) as Record<
      CsOutboxStatus,
      number
    >;
    for (const g of grouped) counts[g.status as CsOutboxStatus] = g._count._all;
    return {
      secretConfigured: this.env.CS_WEBHOOK_SECRET !== undefined,
      workerEnabled: this.env.CS_WEBHOOK_WORKER_ENABLED,
      allowedHosts: this.env.CS_WEBHOOK_ALLOWED_HOSTS,
      endpoints: endpoints.map((e) => toDto(e, user)),
      counts,
      recent: recent.map((r) => ({
        id: r.id,
        requestReference: r.request.reference,
        sequence: r.sequence,
        type: r.type as CsWebhookEventType,
        status: r.status as CsOutboxStatus,
        attempts: r.attempts,
        occurredAt: r.occurredAt.toISOString(),
        nextAttemptAt: r.nextAttemptAt.toISOString(),
        sentAt: r.sentAt?.toISOString() ?? null,
        lastStatus: r.lastStatus,
        lastError: r.lastError,
      })),
    };
  }

  /** A pending endpoint for an active key of the Administrator's branches. */
  async create(
    user: AuthUser,
    apiClientId: string,
    input: CsWebhookEndpointCreate,
  ): Promise<CsWebhooksDto> {
    const url = this.checkUrl(input.url);
    await this.prisma.$transaction(async (tx) => {
      const key = await lockKey(tx, user, apiClientId);
      const row = await tx.csWebhookEndpoint.create({
        data: {
          apiClientId,
          url,
          audience: input.audience,
          status: 'PENDING',
          createdById: user.id,
        },
      });
      await this.log(tx, user, key, 'CREATED', [
        { field: 'webhook', before: null, after: `${row.url} (${row.audience})` },
      ]);
    });
    return this.view(user, apiClientId);
  }

  /**
   * A pending endpoint becomes the key's, approved by someone other than who added it (403
   * SAME_PERSON), with the secret configured and its host still allowed. The approved one it
   * replaces is retired in the same transaction.
   */
  async approve(user: AuthUser, apiClientId: string, id: string): Promise<CsWebhooksDto> {
    if (!this.env.CS_WEBHOOK_SECRET) {
      throw new ConflictException({
        code: 'WEBHOOK_SECRET_MISSING',
        message: 'Set CS_WEBHOOK_SECRET before approving an endpoint',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const key = await lockKey(tx, user, apiClientId);
      const endpoint = await this.endpointOf(tx, apiClientId, id);
      if (endpoint.status !== 'PENDING') {
        throw new ConflictException('Only a pending endpoint is approved');
      }
      if (endpoint.createdById === user.id) {
        throw new ForbiddenException({
          code: 'SAME_PERSON',
          message: 'Someone other than who added the endpoint approves it',
        });
      }
      this.checkUrl(endpoint.url);
      const now = new Date();
      const current = await tx.csWebhookEndpoint.findFirst({
        where: { apiClientId, status: 'APPROVED' },
      });
      if (current) {
        await tx.csWebhookEndpoint.update({
          where: { id: current.id },
          data: { status: 'RETIRED', approvedKey: null, retiredById: user.id, retiredAt: now },
        });
      }
      await tx.csWebhookEndpoint.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedKey: apiClientId,
          approvedById: user.id,
          approvedAt: now,
        },
      });
      await this.log(tx, user, key, 'APPROVED', [
        {
          field: 'webhook',
          before: current ? current.url : null,
          after: `${endpoint.url} (${endpoint.audience})`,
        },
      ]);
    });
    return this.view(user, apiClientId);
  }

  /** A pending or approved endpoint stops: notices still waiting are cancelled when due. */
  async retire(user: AuthUser, apiClientId: string, id: string): Promise<CsWebhooksDto> {
    await this.prisma.$transaction(async (tx) => {
      const key = await lockKey(tx, user, apiClientId, { revokedToo: true });
      const endpoint = await this.endpointOf(tx, apiClientId, id);
      if (endpoint.status === 'RETIRED') {
        throw new ConflictException('The endpoint is already retired');
      }
      await tx.csWebhookEndpoint.update({
        where: { id },
        data: {
          status: 'RETIRED',
          approvedKey: null,
          retiredById: user.id,
          retiredAt: new Date(),
          // A pending one retired was never approved: the check allows no approver then.
        },
      });
      await this.log(tx, user, key, 'CANCELLED', [
        { field: 'webhook', before: endpoint.url, after: null },
      ]);
    });
    return this.view(user, apiClientId);
  }

  private checkUrl(raw: string): string {
    const checked = checkEndpointUrl(raw, this.env.CS_WEBHOOK_ALLOWED_HOSTS);
    if ('problem' in checked) {
      throw new BadRequestException({
        code: checked.problem,
        message: 'The endpoint must be https on port 443 at an allowed host name',
        fields: ['url'],
      });
    }
    return checked.url;
  }

  private async endpointOf(tx: Tx, apiClientId: string, id: string) {
    const endpoint = await tx.csWebhookEndpoint.findFirst({ where: { id, apiClientId } });
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    return endpoint;
  }

  private async log(
    tx: Tx,
    user: AuthUser,
    key: { id: string; name: string; keyPrefix: string },
    action: 'CREATED' | 'APPROVED' | 'CANCELLED',
    changes: { field: string; before: string | null; after: string | null }[],
  ): Promise<void> {
    await this.audit.record(tx, user, {
      branchId: null,
      entity: 'API_CLIENT',
      entityId: key.id,
      reference: `${key.name} (nolcs_${key.keyPrefix})`,
      action,
      changes,
    });
  }
}

/** The key locked, for an Administrator of all its branches; active unless `revokedToo`. */
async function lockKey(
  tx: Tx,
  user: AuthUser,
  id: string,
  options: { revokedToo?: boolean } = {},
): Promise<{ id: string; name: string; keyPrefix: string }> {
  await tx.$queryRaw`SELECT 1 FROM "api_clients" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const key = await tx.apiClient.findUnique({
    where: { id },
    select: { id: true, name: true, keyPrefix: true, isActive: true },
  });
  if (!key) throw new NotFoundException('API key not found');
  const branches = await tx.apiClientBranch.findMany({
    where: { apiClientId: id },
    select: { branchId: true },
  });
  for (const b of branches) assertBranchAccess(user, b.branchId);
  if (!key.isActive && !options.revokedToo) throw new ConflictException('The API key is revoked');
  return key;
}

function toDto(row: EndpointRow, user: AuthUser): CsWebhookEndpointDto {
  return {
    id: row.id,
    url: row.url,
    audience: row.audience,
    status: row.status as CsWebhookEndpointStatus,
    createdByName: row.createdBy.fullName,
    createdAt: row.createdAt.toISOString(),
    approvedByName: row.approvedBy?.fullName ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    canApprove: row.status === 'PENDING' && row.createdById !== user.id,
  };
}
