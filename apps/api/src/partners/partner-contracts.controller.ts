import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  COMMISSION_BASES,
  RATE_UNITS,
  type PartnerContractDto,
  type PartnerContractInput,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import { amount, currencyCode, dateString, optionalText, parse } from '../common/validation.js';
import { dec } from '../common/money.js';
import { PartnerContractsService } from './partner-contracts.service.js';

/**
 * A percentage (at most 100) names no unit or currency; a fixed amount names both. The dates run
 * forward.
 */
const contractBody: z.ZodType<PartnerContractInput> = z
  .object({
    priceCategoryCode: z.string().min(1).max(20).nullish(),
    basis: z.enum(COMMISSION_BASES),
    value: amount,
    unit: z.enum(RATE_UNITS).nullish(),
    currency: currencyCode.nullish(),
    validFrom: dateString,
    validTo: dateString.nullish(),
    notes: optionalText(2000),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.basis === 'PERCENT_OF_PRICE') {
      if (dec(body.value).gt(100)) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage is at most 100' });
      }
      for (const key of ['unit', 'currency'] as const) {
        if (body[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'A percentage has no ' + key });
        }
      }
    } else {
      for (const key of ['unit', 'currency'] as const) {
        if (!body[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `A fixed amount needs a ${key}` });
        }
      }
    }
    if (body.validTo && body.validTo < body.validFrom) {
      ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'Valid to is before valid from' });
    }
  });

/**
 * Partners' commission contracts (business model plan 3.4), settings only. Not readable by the
 * staff AI assistant (no @AgentReadable), and closed to Outlet Staff (no @OutletScoped).
 */
@Controller()
export class PartnerContractsController {
  constructor(private readonly contracts: PartnerContractsService) {}

  @Get('partners/:partnerId/contracts')
  @RequirePermission('partner_contracts:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('partnerId', ParseUUIDPipe) partnerId: string,
  ): Promise<PartnerContractDto[]> {
    return this.contracts.list(user, partnerId);
  }

  @Post('partners/:partnerId/contracts')
  @RequirePermission('partner_contracts:create')
  create(
    @CurrentUser() user: AuthUser,
    @Param('partnerId', ParseUUIDPipe) partnerId: string,
    @Body() body: unknown,
  ): Promise<PartnerContractDto> {
    return this.contracts.create(user, partnerId, parse(contractBody, body));
  }

  @Patch('partner-contracts/:id')
  @RequirePermission('partner_contracts:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<PartnerContractDto> {
    return this.contracts.update(user, id, parse(contractBody, body));
  }

  @Post('partner-contracts/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partner_contracts:approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PartnerContractDto> {
    return this.contracts.approve(user, id);
  }

  @Post('partner-contracts/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('partner_contracts:cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PartnerContractDto> {
    return this.contracts.cancel(user, id);
  }
}
