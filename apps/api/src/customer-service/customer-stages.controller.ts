import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { SHIPMENT_STATUSES, type CustomerStageDto, type CustomerStagesDto } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { parse, requiredText } from '../common/validation.js';
import { CustomerStagesService } from './customer-stages.service.js';

const stageCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'A code of capitals, digits and _');
const stageBody = z
  .object({
    nameAr: requiredText(100),
    nameEn: requiredText(100),
    sortOrder: z.number().int().min(1).max(99),
    isActive: z.boolean(),
  })
  .strict();
const mappingBody = z.object({ stageCode: stageCode.nullable() }).strict();

/** Plan 09 section 3: the customer's stages and their mapping, master data. */
@Controller('customer-stages')
export class CustomerStagesController {
  constructor(private readonly stages: CustomerStagesService) {}

  @Get()
  @RequirePermission('master_data:view')
  list(): Promise<CustomerStagesDto> {
    return this.stages.list();
  }

  @Put('mapping/:status')
  @RequirePermission('master_data:update')
  setMapping(
    @CurrentUser() user: AuthUser,
    @Param('status') status: string,
    @Body() body: unknown,
  ): Promise<CustomerStagesDto> {
    return this.stages.setMapping(
      user,
      parse(z.enum(SHIPMENT_STATUSES), status),
      parse(mappingBody, body).stageCode,
    );
  }

  @Put(':code')
  @RequirePermission('master_data:update')
  setStage(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<CustomerStageDto> {
    return this.stages.setStage(user, parse(stageCode, code), parse(stageBody, body));
  }
}
