import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CustomsClearanceRequest,
  CustomsFeeRequest,
  Permission,
  ShipmentCustomsDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { shipmentScope } from '../shipments/shipment-scope.js';
import { fromDbDateOrNull, toDbDate } from '../common/dates.js';
import { dec, toDecimalString } from '../common/money.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { isActive } from '../shipments/state-machine.js';
import { clearanceProblem, feeTotals, isValidFeeAmount } from './customs-rules.js';

type Tx = Prisma.TransactionClient;

/**
 * The customs file of a shipment (scope 11): clearance status, declaration number, broker,
 * dates, notes and fees. Access follows the shipment. Fees are recorded with their currency
 * only: no journal entry is posted (supplier bills, group 4b, will carry the cost). Moving the
 * shipment to CUSTOMS_IN_PROGRESS / CUSTOMS_CLEARED stays with the shipment state machine.
 */
@Injectable()
export class CustomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly currencies: CurrenciesService,
  ) {}

  async get(user: AuthUser, shipmentId: string): Promise<ShipmentCustomsDto> {
    const shipment = await this.shipments.requireAccessible(user, shipmentId);
    const [clearance, fees] = await Promise.all([
      this.prisma.customsClearance.findFirst({
        where: { shipmentId, shipment: shipmentScope(user) },
        include: { updatedBy: { select: { fullName: true } } },
      }),
      this.prisma.customsFee.findMany({
        where: { shipmentId, shipment: shipmentScope(user) },
        include: { createdBy: { select: { fullName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const has = (permission: Permission) => user.permissions.has(permission);
    const active = isActive(shipment.status);
    return {
      clearance: clearance && {
        status: clearance.status,
        declarationNumber: clearance.declarationNumber,
        brokerName: clearance.brokerName,
        submittedOn: fromDbDateOrNull(clearance.submittedOn),
        clearedOn: fromDbDateOrNull(clearance.clearedOn),
        note: clearance.note,
        updatedByName: clearance.updatedBy.fullName,
        updatedAt: clearance.updatedAt.toISOString(),
      },
      fees: fees.map((f) => ({
        id: f.id,
        description: f.description,
        amount: toDecimalString(f.amount),
        currency: f.currency,
        note: f.note,
        createdByName: f.createdBy.fullName,
        createdAt: f.createdAt.toISOString(),
      })),
      totals: feeTotals(fees).map((t) => ({
        currency: t.currency,
        amount: toDecimalString(t.amount),
      })),
      actions: {
        canEdit: active && has('customs:update'),
        canAddFee: active && has('customs:create'),
        canRemoveFee: active && has('customs:cancel'),
      },
    };
  }

  /** Creates or replaces the customs file. 409 once the shipment is closed or cancelled. */
  async save(
    user: AuthUser,
    shipmentId: string,
    input: CustomsClearanceRequest,
  ): Promise<ShipmentCustomsDto> {
    const shipment = await this.requireActive(user, shipmentId);
    const problem = clearanceProblem(input);
    if (problem) throw new BadRequestException(problem);
    const fields = {
      status: input.status,
      declarationNumber: input.declarationNumber ?? null,
      brokerName: input.brokerName ?? null,
      submittedOn: input.submittedOn ? toDbDate(input.submittedOn) : null,
      clearedOn: input.clearedOn ? toDbDate(input.clearedOn) : null,
      note: input.note ?? null,
      updatedById: user.id,
    };
    await this.prisma.$transaction(async (tx) => {
      await this.lockActive(tx, shipmentId);
      await tx.customsClearance.upsert({
        where: { shipmentId },
        create: { ...fields, shipmentId, branchId: shipment.branchId },
        update: fields,
      });
    });
    return this.get(user, shipmentId);
  }

  async addFee(
    user: AuthUser,
    shipmentId: string,
    input: CustomsFeeRequest,
  ): Promise<ShipmentCustomsDto> {
    const shipment = await this.requireActive(user, shipmentId);
    const currency = await this.currencies.requireActive(input.currency);
    const amount = dec(input.amount);
    if (!isValidFeeAmount(amount, currency.decimalPlaces)) {
      throw new BadRequestException(
        `Amount must be positive with ${currency.decimalPlaces} decimal places`,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockActive(tx, shipmentId);
      await tx.customsFee.create({
        data: {
          branchId: shipment.branchId,
          shipmentId,
          description: input.description,
          amount,
          currency: currency.code,
          note: input.note ?? null,
          createdById: user.id,
        },
      });
    });
    return this.get(user, shipmentId);
  }

  /** Removes a fee entered by mistake (nothing was posted for it). */
  async removeFee(user: AuthUser, shipmentId: string, feeId: string): Promise<ShipmentCustomsDto> {
    await this.requireActive(user, shipmentId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockActive(tx, shipmentId);
      const { count } = await tx.customsFee.deleteMany({
        where: { id: feeId, shipmentId, shipment: shipmentScope(user) },
      });
      if (count === 0) throw new NotFoundException('Fee not found');
    });
    return this.get(user, shipmentId);
  }

  private async requireActive(
    user: AuthUser,
    shipmentId: string,
  ): Promise<{ id: string; branchId: string }> {
    const shipment = await this.shipments.requireAccessible(user, shipmentId);
    if (!isActive(shipment.status)) {
      throw new ConflictException('A closed or cancelled shipment cannot be edited');
    }
    return shipment;
  }

  /** Under the shipment lock: a close or cancel that commits meanwhile is seen here. */
  private async lockActive(tx: Tx, shipmentId: string): Promise<void> {
    if (!isActive(await this.shipments.lockForChildWrite(tx, shipmentId))) {
      throw new ConflictException('A closed or cancelled shipment cannot be edited');
    }
  }
}
