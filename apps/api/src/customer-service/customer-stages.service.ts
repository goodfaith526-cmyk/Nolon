import { Injectable, NotFoundException } from '@nestjs/common';
import {
  SHIPMENT_STATUSES,
  type CustomerStageDto,
  type CustomerStageInput,
  type CustomerStagesDto,
  type ShipmentStatus,
} from '@nolon/shared';
import { AuditService, codeEntityId } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { StageRow } from './customer-stages.js';

function dto(r: StageRow): CustomerStageDto {
  return {
    code: r.code,
    nameAr: r.nameAr,
    nameEn: r.nameEn,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
  };
}

/**
 * Plan 09 section 3: the stages a customer reads and which internal status shows as which,
 * master data the Administrator keeps (master_data:update), every change in the audit log. The
 * code holds no stage name; the bot reads them through the booking request.
 */
@Injectable()
export class CustomerStagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The stages and the mapping, as maps for the request read. */
  async maps(): Promise<{ stages: Map<string, StageRow>; mapping: Map<string, string> }> {
    const [stages, mapping] = await Promise.all([
      this.prisma.customerStage.findMany(),
      this.prisma.shipmentStatusStage.findMany(),
    ]);
    return {
      stages: new Map(stages.map((s) => [s.code, s])),
      mapping: new Map(mapping.map((m) => [m.status, m.stageCode])),
    };
  }

  async list(): Promise<CustomerStagesDto> {
    const { stages, mapping } = await this.maps();
    return {
      stages: [...stages.values()]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
        .map(dto),
      mapping: SHIPMENT_STATUSES.map((status) => ({
        status,
        stageCode: mapping.get(status) ?? null,
      })),
    };
  }

  /** Adds or changes a stage (its names, order, whether it shows). */
  async setStage(
    user: AuthUser,
    code: string,
    input: CustomerStageInput,
  ): Promise<CustomerStageDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "customer_stages" WHERE "code" = ${code} FOR UPDATE`;
      const before = await tx.customerStage.findUnique({ where: { code } });
      const after = before
        ? await tx.customerStage.update({ where: { code }, data: input })
        : await tx.customerStage.create({ data: { code, ...input } });
      const fields = ['nameAr', 'nameEn', 'sortOrder', 'isActive'] as const;
      await this.audit.record(tx, user, {
        branchId: null,
        entity: 'CUSTOMER_STAGE',
        entityId: codeEntityId('CUSTOMER_STAGE', code),
        reference: code,
        action: before ? 'UPDATED' : 'CREATED',
        changes: fields.flatMap((field) => {
          const was = before ? String(before[field]) : null;
          const now = String(after[field]);
          return was === now ? [] : [{ field, before: was, after: now }];
        }),
      });
      return dto(after);
    });
  }

  /** Which stage a status shows as; null = the customer is sent to staff. */
  async setMapping(
    user: AuthUser,
    status: ShipmentStatus,
    stageCode: string | null,
  ): Promise<CustomerStagesDto> {
    await this.prisma.$transaction(async (tx) => {
      if (stageCode !== null) {
        const found = await tx.$queryRaw<{ code: string }[]>`
          SELECT "code" FROM "customer_stages" WHERE "code" = ${stageCode} FOR SHARE`;
        if (found.length === 0) throw new NotFoundException(`Unknown stage: ${stageCode}`);
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('shipment_status_stages', 0))`;
      const before = await tx.shipmentStatusStage.findUnique({ where: { status } });
      if ((before?.stageCode ?? null) === stageCode) return;
      if (stageCode === null) {
        await tx.shipmentStatusStage.delete({ where: { status } });
      } else {
        await tx.shipmentStatusStage.upsert({
          where: { status },
          create: { status, stageCode },
          update: { stageCode },
        });
      }
      await this.audit.record(tx, user, {
        branchId: null,
        entity: 'CUSTOMER_STAGE',
        entityId: codeEntityId('CUSTOMER_STAGE', `status:${status}`),
        reference: status,
        action: 'UPDATED',
        changes: [{ field: 'stage', before: before?.stageCode ?? null, after: stageCode }],
      });
    });
    return this.list();
  }
}
