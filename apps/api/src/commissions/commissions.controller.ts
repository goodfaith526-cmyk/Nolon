import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  COMMISSION_ROLES,
  type CommissionsDueDto,
  type CreatePartnerStatementInput,
  type ManualCommissionInput,
  type PartnerCommissionsDto,
  type PartnerStatementBillInput,
  type PartnerStatementDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { currencyCode, dateString, optionalText, parse } from '../common/validation.js';
import { CommissionAccrualService } from './commission-accrual.service.js';
import { CommissionsDueService } from './commissions-due.service.js';
import { PartnerStatementsService } from './partner-statements.service.js';

/** A signed amount: positive accrues, negative reduces (the service refuses zero). */
const signedAmount = z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/, 'Invalid amount');

const manualBody: z.ZodType<ManualCommissionInput> = z
  .object({
    requestId: z.uuid(),
    shipmentId: z.uuid(),
    role: z.enum(COMMISSION_ROLES),
    currency: currencyCode,
    amount: signedAmount,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const statementBody: z.ZodType<CreatePartnerStatementInput> = z
  .object({ branchId: z.uuid(), currency: currencyCode, periodTo: dateString })
  .strict();

const statementBillBody: z.ZodType<PartnerStatementBillInput> = z
  .object({
    requestId: z.uuid(),
    billDate: dateString,
    dueDate: dateString.optional(),
    supplierReference: optionalText(50).transform((v) => v ?? undefined),
  })
  .strict();

/**
 * Partner commissions (plan 07, rule 16): what each partner earned on its shipments, the holds,
 * a recompute and a manual adjustment. Not readable by the staff AI assistant (no @AgentReadable),
 * and closed to Outlet Staff (no @OutletScoped).
 */
@Controller()
export class CommissionsController {
  constructor(
    private readonly commissions: CommissionAccrualService,
    private readonly statements: PartnerStatementsService,
    private readonly dueReport: CommissionsDueService,
  ) {}

  @Get('partners/:partnerId/commissions')
  @RequirePermission('partner_commissions:view')
  forPartner(
    @CurrentUser() user: AuthUser,
    @Param('partnerId', ParseUUIDPipe) partnerId: string,
  ): Promise<PartnerCommissionsDto> {
    return this.commissions.forPartner(user, partnerId);
  }

  @Post('partners/:partnerId/commissions/adjustments')
  @RequirePermission('partner_commissions:approve')
  adjust(
    @CurrentUser() user: AuthUser,
    @Param('partnerId', ParseUUIDPipe) partnerId: string,
    @Body() body: unknown,
  ): Promise<PartnerCommissionsDto> {
    return this.commissions.adjust(user, partnerId, parse(manualBody, body));
  }

  @Post('shipments/:shipmentId/commissions/recompute')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partner_commissions:approve')
  recompute(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<{ holds: number }> {
    return this.commissions.recompute(user, shipmentId);
  }

  @Get('partner-commissions/due')
  @RequirePermission('partner_commissions:view')
  due(@CurrentUser() user: AuthUser): Promise<CommissionsDueDto> {
    return this.dueReport.due(user);
  }

  @Post('partners/:partnerId/statements')
  @RequirePermission('partner_commissions:create')
  createStatement(
    @CurrentUser() user: AuthUser,
    @Param('partnerId', ParseUUIDPipe) partnerId: string,
    @Body() body: unknown,
  ): Promise<PartnerStatementDto> {
    return this.statements.create(user, partnerId, parse(statementBody, body));
  }

  @Get('partner-statements/:id')
  @RequirePermission('partner_commissions:view')
  statement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PartnerStatementDto> {
    return this.statements.get(user, id);
  }

  @Post('partner-statements/:id/bill')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partner_commissions:create')
  billStatement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PartnerStatementDto> {
    return this.statements.bill(user, id, parse(statementBillBody, body));
  }

  @Post('partner-statements/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partner_commissions:update')
  cancelStatement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PartnerStatementDto> {
    return this.statements.cancel(user, id);
  }
}
