import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  SUPPLIER_BILL_LINE_KINDS,
  SUPPLIER_BILL_STATUSES,
  SUPPLIER_PAYMENT_STATUSES,
  type BillableTripDto,
  type Page,
  type SupplierBillDto,
  type SupplierBillSummaryDto,
  type SupplierDto,
  type SupplierPaymentDto,
  type SupplierPaymentSummaryDto,
  type SupplierSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import {
  amount,
  currencyCode,
  dateString,
  fxRate,
  optionalText,
  pageQuery,
  parse,
  phone,
  requiredText,
} from '../common/validation.js';
import { SupplierBillsService } from './supplier-bills.service.js';
import { SupplierPaymentsService } from './supplier-payments.service.js';
import { SuppliersService } from './suppliers.service.js';

const supplierFields = {
  name: requiredText(200),
  phone: phone.nullish(),
  email: z.email().max(254).nullish(),
  taxNumber: optionalText(50),
  paymentTermsDays: z.number().int().min(0).max(3650).optional(),
  notes: optionalText(2000),
};
const supplierBody = z.object(supplierFields).strict();
const supplierUpdateBody = z
  .object({ ...supplierFields, isActive: z.boolean() })
  .partial()
  .strict();
const supplierListQuery = pageQuery.extend({
  activeOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
const billableTripsQuery = z.object({ branchId: z.uuid().optional() });

const billLine = z
  .object({
    kind: z.enum(SUPPLIER_BILL_LINE_KINDS),
    chargeTypeCode: z.string().trim().toUpperCase().min(1).max(20).nullish(),
    shipmentId: z.uuid().nullish(),
    tripId: z.uuid().nullish(),
    expenseCategoryCode: z.string().trim().toUpperCase().min(1).max(20).nullish(),
    consolidationId: z.uuid().nullish(),
    description: optionalText(500),
    amount,
  })
  .strict();
const billFields = {
  branchId: z.uuid(),
  supplierReference: optionalText(50),
  currency: currencyCode,
  fxRate: fxRate.nullish(),
  billDate: dateString,
  dueDate: dateString,
  notes: optionalText(2000),
  lines: z.array(billLine).min(1).max(100),
};
const createBillBody = z
  .object({ requestId: z.uuid(), supplierId: z.uuid(), ...billFields })
  .strict();
const updateBillBody = z.object(billFields).strict();
const billListQuery = pageQuery.extend({
  status: z.enum(SUPPLIER_BILL_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  openOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
const openingBillBody = z
  .object({
    requestId: z.uuid(),
    supplierId: z.uuid(),
    branchId: z.uuid(),
    entryDate: dateString,
    reference: requiredText(50),
    billDate: dateString,
    dueDate: dateString,
    currency: currencyCode,
    fxRate: fxRate.nullish(),
    amount,
  })
  .strict();
const reasonBody = z.object({ reason: requiredText(1000) }).strict();

const createPaymentBody = z
  .object({
    requestId: z.uuid(),
    supplierId: z.uuid(),
    branchId: z.uuid(),
    paymentDate: dateString,
    currency: currencyCode,
    fxRate: fxRate.nullish(),
    cashAccountId: z.uuid(),
    reference: optionalText(100),
    notes: optionalText(2000),
    allocations: z
      .array(z.object({ billId: z.uuid(), amount }).strict())
      .min(1)
      .max(100),
  })
  .strict();
const paymentListQuery = pageQuery.extend({
  status: z.enum(SUPPLIER_PAYMENT_STATUSES).optional(),
  supplierId: z.uuid().optional(),
});

/** Suppliers: master data shared by all branches (annex A, "suppliers and their bills"). */
@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly bills: SupplierBillsService,
  ) {}

  @AgentReadable()
  @Get()
  @RequirePermission('suppliers:view')
  list(@Query() query: unknown): Promise<Page<SupplierSummaryDto>> {
    return this.suppliers.list(parse(supplierListQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('suppliers:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<SupplierDto> {
    return this.suppliers.get(user, id);
  }

  @Post()
  @RequirePermission('suppliers:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<SupplierDto> {
    return this.suppliers.create(user, parse(supplierBody, body));
  }

  @Patch(':id')
  @RequirePermission('suppliers:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SupplierDto> {
    return this.suppliers.update(user, id, parse(supplierUpdateBody, body));
  }

  /** Links a carrier to the supplier whose bills settle its trips (annex C rule 11a). */
  @Put(':id/carriers/:carrierId')
  @RequirePermission('suppliers:update', 'transport_fleet:view')
  linkCarrier(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('carrierId', ParseUUIDPipe) carrierId: string,
  ): Promise<SupplierDto> {
    return this.suppliers.setCarrier(user, id, carrierId, true);
  }

  @Delete(':id/carriers/:carrierId')
  @RequirePermission('suppliers:update', 'transport_fleet:view')
  unlinkCarrier(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('carrierId', ParseUUIDPipe) carrierId: string,
  ): Promise<SupplierDto> {
    return this.suppliers.setCarrier(user, id, carrierId, false);
  }

  /** Completed external trips of the supplier's carriers not billed yet. */
  @AgentReadable()
  @Get(':id/billable-trips')
  @RequirePermission('suppliers:view', 'transport_trips:view')
  billableTrips(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<BillableTripDto[]> {
    return this.bills.billableTrips(user, id, parse(billableTripsQuery, query).branchId);
  }
}

@Controller('supplier-bills')
export class SupplierBillsController {
  constructor(private readonly bills: SupplierBillsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('suppliers:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<Page<SupplierBillSummaryDto>> {
    return this.bills.list(user, parse(billListQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('suppliers:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupplierBillDto> {
    return this.bills.get(user, id);
  }

  @Post()
  @RequirePermission('suppliers:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<SupplierBillDto> {
    return this.bills.create(user, parse(createBillBody, body));
  }

  /** A supplier's open bill at go-live (annex C rule 15), approved and posted at once. */
  @Post('opening')
  @RequirePermission('suppliers:view', 'manual_journals:create', 'manual_journals:approve')
  createOpeningItem(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ): Promise<SupplierBillDto> {
    return this.bills.createOpeningItem(user, parse(openingBillBody, body));
  }

  @Patch(':id')
  @RequirePermission('suppliers:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SupplierBillDto> {
    return this.bills.update(user, id, parse(updateBillBody, body));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('suppliers:approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupplierBillDto> {
    return this.bills.approve(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('suppliers:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SupplierBillDto> {
    return this.bills.cancel(user, id, parse(reasonBody, body).reason);
  }
}

@Controller('supplier-payments')
export class SupplierPaymentsController {
  constructor(private readonly payments: SupplierPaymentsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('supplier_payments:view')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ): Promise<Page<SupplierPaymentSummaryDto>> {
    return this.payments.list(user, parse(paymentListQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('supplier_payments:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupplierPaymentDto> {
    return this.payments.get(user, id);
  }

  @Post()
  @RequirePermission('supplier_payments:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<SupplierPaymentDto> {
    return this.payments.create(user, parse(createPaymentBody, body));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('supplier_payments:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SupplierPaymentDto> {
    return this.payments.cancel(user, id, parse(reasonBody, body).reason);
  }
}
