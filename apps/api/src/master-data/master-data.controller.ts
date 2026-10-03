import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  LOCATION_KINDS,
  type CodeNameDto,
  type LocationDto,
  type MasterDataDto,
} from '@nolon/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { countryCode, parse, requiredText } from '../common/validation.js';
import { MasterDataService } from './master-data.service.js';

const code = (max: number) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]+$/)
    .min(1)
    .max(max);

const locationBody = z
  .object({
    code: code(10),
    kind: z.enum(LOCATION_KINDS),
    nameEn: requiredText(200),
    nameAr: requiredText(200),
    countryCode,
    isActive: z.boolean().optional(),
  })
  .strict();

const codeNameBody = (max: number) =>
  z
    .object({
      code: code(max),
      nameEn: requiredText(200),
      nameAr: requiredText(200),
      isActive: z.boolean().optional(),
    })
    .strict();

@Controller('master-data')
export class MasterDataController {
  constructor(private readonly masterData: MasterDataService) {}

  @Get()
  @RequirePermission('master_data:view')
  all(): Promise<MasterDataDto> {
    return this.masterData.all();
  }

  @Post('locations')
  @RequirePermission('master_data:create')
  createLocation(@Body() body: unknown): Promise<LocationDto> {
    return this.masterData.createLocation(parse(locationBody, body));
  }

  @Patch('locations/:id')
  @RequirePermission('master_data:update')
  updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<LocationDto> {
    return this.masterData.updateLocation(id, parse(locationBody.partial(), body));
  }

  @Put('container-types')
  @RequirePermission('master_data:create', 'master_data:update')
  upsertContainerType(@Body() body: unknown): Promise<CodeNameDto> {
    return this.masterData.upsertContainerType(parse(codeNameBody(10), body));
  }

  @Put('charge-types')
  @RequirePermission('master_data:create', 'master_data:update')
  upsertChargeType(@Body() body: unknown): Promise<CodeNameDto> {
    return this.masterData.upsertChargeType(parse(codeNameBody(20), body));
  }
}
