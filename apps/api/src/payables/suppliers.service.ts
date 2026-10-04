import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Page,
  SupplierDto,
  SupplierInput,
  SupplierSummaryDto,
  SupplierUpdateRequest,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import type { PageQuery } from '../common/validation.js';
import type { Prisma, Supplier } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FleetService } from '../transport/fleet.service.js';

type Tx = Prisma.TransactionClient;

const details = {
  carriers: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
} satisfies Prisma.SupplierInclude;

type SupplierWithDetails = Prisma.SupplierGetPayload<{ include: typeof details }>;

/**
 * Suppliers (scope 13): shipping lines, carriers, customs brokers, warehouses... Master data
 * shared by every branch, like carriers; their bills and payments are branch-owned. A carrier is
 * linked to the supplier whose bills settle its trips (annex C rule 11a). Deactivate, never delete.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fleet: FleetService,
  ) {}

  async list(query: PageQuery & { activeOnly?: boolean }): Promise<Page<SupplierSummaryDto>> {
    const where: Prisma.SupplierWhereInput = {
      ...(query.activeOnly ? { isActive: true } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { number: { contains: query.q, mode: 'insensitive' } },
              { phone: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.supplier.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: query.page, pageSize: query.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<SupplierDto> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id }, include: details });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return toDto(supplier, user);
  }

  async create(user: AuthUser, input: SupplierInput): Promise<SupplierDto> {
    const created = await this.prisma.$transaction(async (tx) => {
      const number = formatDocumentNumber('SUP', await nextSequenceValue(tx, 'SUPPLIER'));
      return tx.supplier.create({
        data: {
          number,
          name: input.name,
          phone: input.phone ?? null,
          email: input.email ?? null,
          taxNumber: input.taxNumber ?? null,
          paymentTermsDays: input.paymentTermsDays ?? 0,
          notes: input.notes ?? null,
          createdById: user.id,
        },
      });
    });
    return this.get(user, created.id);
  }

  async update(user: AuthUser, id: string, input: SupplierUpdateRequest): Promise<SupplierDto> {
    await this.prisma.$transaction(async (tx) => {
      await lockSupplier(tx, id, 'UPDATE');
      await tx.supplier.update({ where: { id }, data: input });
    });
    return this.get(user, id);
  }

  /** Links a carrier to this (active) supplier, or unlinks it (`link` false). */
  async setCarrier(
    user: AuthUser,
    id: string,
    carrierId: string,
    link: boolean,
  ): Promise<SupplierDto> {
    await this.prisma.$transaction(async (tx) => {
      const supplier = await lockSupplier(tx, id, 'SHARE');
      if (link && !supplier.isActive) throw new BadRequestException('The supplier is inactive');
      await this.fleet.setCarrierSupplier(
        tx,
        carrierId,
        link ? { supplierId: id } : { unlinkFrom: id },
      );
    });
    return this.get(user, id);
  }

  /** 404 unless the supplier exists (active or not): for reads and settling existing bills. */
  async requireSupplier(id: string): Promise<Supplier> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  /**
   * Inside the caller's transaction: the supplier, share-locked so it is not deactivated until the
   * caller commits; 400 when it is inactive.
   */
  async requireActiveInTx(tx: Tx, id: string): Promise<Supplier> {
    const supplier = await lockSupplier(tx, id, 'SHARE');
    if (!supplier.isActive) throw new BadRequestException('The supplier is inactive');
    return supplier;
  }
}

async function lockSupplier(tx: Tx, id: string, mode: 'UPDATE' | 'SHARE'): Promise<Supplier> {
  const rows =
    mode === 'UPDATE'
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "suppliers" WHERE "id" = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "suppliers" WHERE "id" = ${id}::uuid FOR SHARE`;
  if (rows.length === 0) throw new NotFoundException('Supplier not found');
  return tx.supplier.findUniqueOrThrow({ where: { id } });
}

function toSummary(s: Supplier): SupplierSummaryDto {
  return { id: s.id, number: s.number, name: s.name, phone: s.phone, isActive: s.isActive };
}

function toDto(s: SupplierWithDetails, user: AuthUser): SupplierDto {
  return {
    ...toSummary(s),
    email: s.email,
    taxNumber: s.taxNumber,
    paymentTermsDays: s.paymentTermsDays,
    notes: s.notes,
    carriers: s.carriers,
    actions: { canEdit: user.permissions.has('suppliers:update') },
  };
}
