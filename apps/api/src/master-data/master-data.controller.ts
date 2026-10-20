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
  LOCATION_KINDS,
  type CodeNameDto,
  type CurrencyDto,
  type LocationDto,
  type MasterDataDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentReadable, CurrentUser, RequirePermission } from '../auth/decorators.js';
import {
  clearableText,
  countryCode,
  optionalText,
  parse,
  requiredText,
} from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import { MasterDataService, type CodeType } from './master-data.service.js';

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
    cityId: z.uuid().nullish(),
  })
  .strict();

/** Document type codes are words joined by underscores, e.g. COMMERCIAL_INVOICE. */
const documentTypeCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]+(_[A-Z0-9]+)*$/)
  .max(30);

const CODES: Record<CodeType, z.ZodType<string>> = {
  CONTAINER_TYPE: code(10),
  CHARGE_TYPE: code(20),
  DOCUMENT_TYPE: documentTypeCode,
};

const names = {
  nameEn: requiredText(200),
  nameAr: requiredText(200),
};

/** A new entry: it starts active (deactivate it afterwards). */
const codeNameBody = (type: CodeType) => z.object({ code: CODES[type], ...names }).strict();

/** An edit names only what may change: the code is fixed (strict, so `code` is a 400). */
const codeNameUpdate = z.object(names).partial().strict();

const currencyBody = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/),
    ...names,
    symbol: optionalText(8),
    decimalPlaces: z.number().int().min(0).max(4),
  })
  .strict();

/** Code and decimal places are fixed once created: amounts were rounded with them. */
const currencyUpdate = z
  .object({ ...names, symbol: clearableText(8) })
  .partial()
  .strict();

/** The code in a route, as stored (upper case). */
function codeParam(value: string): string {
  return value.trim().toUpperCase();
}

@Controller('master-data')
export class MasterDataController {
  constructor(
    private readonly masterData: MasterDataService,
    private readonly currencies: CurrenciesService,
  ) {}

  @AgentReadable()
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

  // Container, charge and document types, and currencies: add, rename, deactivate, reactivate.
  // Only the Administrator holds master_data:create and :update; every change is in the audit log.

  @Post('container-types')
  @RequirePermission('master_data:create')
  createContainerType(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<CodeNameDto> {
    return this.createCodeType(user, 'CONTAINER_TYPE', body);
  }

  @Patch('container-types/:code')
  @RequirePermission('master_data:update')
  updateContainerType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<CodeNameDto> {
    return this.updateCodeType(user, 'CONTAINER_TYPE', code, body);
  }

  @Post('container-types/:code/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('master_data:update')
  deactivateContainerType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<CodeNameDto> {
    return this.masterData.setCodeTypeActive(user, 'CONTAINER_TYPE', codeParam(code), false);
  }

  @Post('container-types/:code/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('master_data:update')
  reactivateContainerType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<CodeNameDto> {
    return this.masterData.setCodeTypeActive(user, 'CONTAINER_TYPE', codeParam(code), true);
  }

  @Post('charge-types')
  @RequirePermission('master_data:create')
  createChargeType(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<CodeNameDto> {
    return this.createCodeType(user, 'CHARGE_TYPE', body);
  }

  @Patch('charge-types/:code')
  @RequirePermission('master_data:update')
  updateChargeType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<CodeNameDto> {
    return this.updateCodeType(user, 'CHARGE_TYPE', code, body);
  }

  @Post('charge-types/:code/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('master_data:update')
  deactivateChargeType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<CodeNameDto> {
    return this.masterData.setCodeTypeActive(user, 'CHARGE_TYPE', codeParam(code), false);
  }

  @Post('charge-types/:code/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('master_data:update')
  reactivateChargeType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<CodeNameDto> {
    return this.masterData.setCodeTypeActive(user, 'CHARGE_TYPE', codeParam(code), true);
  }

  @Post('document-types')
  @RequirePermission('master_data:create')
  createDocumentType(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<CodeNameDto> {
    return this.createCodeType(user, 'DOCUMENT_TYPE', body);
  }

  @Patch('document-types/:code')
  @RequirePermission('master_data:update')
  updateDocumentType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<CodeNameDto> {
    return this.updateCodeType(user, 'DOCUMENT_TYPE', code, body);
  }

  @Post('document-types/:code/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('master_data:update')
  deactivateDocumentType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<CodeNameDto> {
    return this.masterData.setCodeTypeActive(user, 'DOCUMENT_TYPE', codeParam(code), false);
  }

  @Post('document-types/:code/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('master_data:update')
  reactivateDocumentType(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<CodeNameDto> {
    return this.masterData.setCodeTypeActive(user, 'DOCUMENT_TYPE', codeParam(code), true);
  }

  @Post('currencies')
  @RequirePermission('master_data:create')
  createCurrency(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<CurrencyDto> {
    return this.currencies.create(user, parse(currencyBody, body));
  }

  @Patch('currencies/:code')
  @RequirePermission('master_data:update')
  updateCurrency(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() body: unknown,
  ): Promise<CurrencyDto> {
    return this.currencies.update(user, codeParam(code), parse(currencyUpdate, body));
  }

  @Post('currencies/:code/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('master_data:update')
  deactivateCurrency(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<CurrencyDto> {
    return this.currencies.setActive(user, codeParam(code), false);
  }

  @Post('currencies/:code/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('master_data:update')
  reactivateCurrency(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
  ): Promise<CurrencyDto> {
    return this.currencies.setActive(user, codeParam(code), true);
  }

  private createCodeType(user: AuthUser, type: CodeType, body: unknown): Promise<CodeNameDto> {
    return this.masterData.createCodeType(user, type, parse(codeNameBody(type), body));
  }

  private updateCodeType(
    user: AuthUser,
    type: CodeType,
    code: string,
    body: unknown,
  ): Promise<CodeNameDto> {
    return this.masterData.updateCodeType(user, type, codeParam(code), parse(codeNameUpdate, body));
  }
}
