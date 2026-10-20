import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import {
  CUSTOMS_STATUSES,
  type CustomsBrokerOptionDto,
  type ShipmentCustomsDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission, AgentReadable } from '../auth/decorators.js';
import {
  amount,
  currencyCode,
  dateString,
  optionalText,
  parse,
  requiredText,
} from '../common/validation.js';
import { CustomsService } from './customs.service.js';

const clearanceBody = z
  .object({
    status: z.enum(CUSTOMS_STATUSES),
    declarationNumber: optionalText(50),
    brokerName: optionalText(200),
    brokerSupplierId: z.uuid().nullish(),
    submittedOn: dateString.nullish(),
    clearedOn: dateString.nullish(),
    note: optionalText(2000),
  })
  .strict();

const feeBody = z
  .object({
    description: requiredText(200),
    amount,
    currency: currencyCode,
    note: optionalText(1000),
  })
  .strict();

/** The customs file of a shipment, inside the shipment page. */
@Controller('shipments/:shipmentId/customs')
export class CustomsController {
  constructor(private readonly customs: CustomsService) {}

  @AgentReadable()
  @Get()
  @RequirePermission('customs:view')
  get(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<ShipmentCustomsDto> {
    return this.customs.get(user, shipmentId);
  }

  @Put()
  @RequirePermission('customs:update')
  save(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() body: unknown,
  ): Promise<ShipmentCustomsDto> {
    return this.customs.save(user, shipmentId, parse(clearanceBody, body));
  }

  /** The brokers the file can be linked to, for those who edit it (group Z2). */
  @Get('brokers')
  @RequirePermission('customs:update')
  brokerOptions(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
  ): Promise<CustomsBrokerOptionDto[]> {
    return this.customs.brokerOptions(user, shipmentId);
  }

  @Post('fees')
  @RequirePermission('customs:create')
  addFee(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Body() body: unknown,
  ): Promise<ShipmentCustomsDto> {
    return this.customs.addFee(user, shipmentId, parse(feeBody, body));
  }

  @Delete('fees/:feeId')
  @RequirePermission('customs:cancel')
  removeFee(
    @CurrentUser() user: AuthUser,
    @Param('shipmentId', ParseUUIDPipe) shipmentId: string,
    @Param('feeId', ParseUUIDPipe) feeId: string,
  ): Promise<ShipmentCustomsDto> {
    return this.customs.removeFee(user, shipmentId, feeId);
  }
}
