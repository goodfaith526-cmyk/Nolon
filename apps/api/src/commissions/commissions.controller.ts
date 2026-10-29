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
  type ManualCommissionInput,
  type PartnerCommissionsDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { currencyCode, parse } from '../common/validation.js';
import { CommissionAccrualService } from './commission-accrual.service.js';

/** A signed amount: positive accrues, negative reduces (the service refuses zero). */
const signedAmount = z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/, 'Invalid amount');

const manualBody: z.ZodType<ManualCommissionInput> = z
  .object({
    shipmentId: z.uuid(),
    role: z.enum(COMMISSION_ROLES),
    currency: currencyCode,
    amount: signedAmount,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/**
 * Partner commissions (plan 07, rule 16): what each partner earned on its shipments, the holds,
 * a recompute and a manual adjustment. Not readable by the staff AI assistant (no @AgentReadable),
 * and closed to Outlet Staff (no @OutletScoped).
 */
@Controller()
export class CommissionsController {
  constructor(private readonly commissions: CommissionAccrualService) {}

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
}
