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
  Query,
} from '@nestjs/common';
import {
  CUSTOMER_KINDS,
  LOCALES,
  type CustomerDto,
  type CustomerSummaryDto,
  type Page,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import {
  amount,
  countryCode,
  currencyCode,
  optionalText,
  pageQuery,
  parse,
  phone,
  requiredText,
} from '../common/validation.js';
import { CustomersService } from './customers.service.js';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  .nullish()
  .or(z.literal('').transform(() => null));

const customerFields = {
  kind: z.enum(CUSTOMER_KINDS),
  name: requiredText(200),
  companyName: optionalText(200),
  phone,
  whatsapp: phone.nullish(),
  email,
  countryCode: countryCode.nullish(),
  city: optionalText(100),
  address: optionalText(500),
  taxNumber: optionalText(50),
  preferredCurrency: currencyCode.nullish(),
  preferredLocale: z.enum(LOCALES).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  creditLimit: amount.nullish(),
  creditLimitCurrency: currencyCode.nullish(),
  notes: optionalText(2000),
};

const createBody = z.object({ branchId: z.uuid(), ...customerFields }).strict();
const updateBody = z.object(customerFields).partial().strict();

const contactBody = z
  .object({
    name: requiredText(200),
    position: optionalText(100),
    phone,
    email,
    idNumber: optionalText(50),
    canInquire: z.boolean().optional(),
    canReceiveCargo: z.boolean().optional(),
    canReceiveDocuments: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const partyBody = z
  .object({
    name: requiredText(200),
    companyName: optionalText(200),
    phone: phone.nullish(),
    email,
    countryCode: countryCode.nullish(),
    city: optionalText(100),
    address: optionalText(500),
  })
  .strict();

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customers:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<CustomerSummaryDto>> {
    return this.customers.list(user, parse(pageQuery, query));
  }

  @Get(':id')
  @RequirePermission('customers:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<CustomerDto> {
    return this.customers.get(user, id);
  }

  @Post()
  @RequirePermission('customers:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<CustomerDto> {
    return this.customers.create(user, parse(createBody, body));
  }

  @Patch(':id')
  @RequirePermission('customers:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerDto> {
    return this.customers.update(user, id, parse(updateBody, body));
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:update')
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerDto> {
    return this.customers.setActive(user, id, false);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('customers:update')
  activate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerDto> {
    return this.customers.setActive(user, id, true);
  }

  @Post(':id/contacts')
  @RequirePermission('customers:update')
  addContact(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerDto> {
    return this.customers.addContact(user, id, parse(contactBody, body));
  }

  @Patch(':id/contacts/:contactId')
  @RequirePermission('customers:update')
  updateContact(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() body: unknown,
  ): Promise<CustomerDto> {
    return this.customers.updateContact(user, id, contactId, parse(contactBody.partial(), body));
  }

  @Post(':id/parties')
  @RequirePermission('customers:update')
  addParty(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerDto> {
    return this.customers.addParty(user, id, parse(partyBody, body));
  }

  @Patch(':id/parties/:partyId')
  @RequirePermission('customers:update')
  updateParty(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Body() body: unknown,
  ): Promise<CustomerDto> {
    return this.customers.updateParty(user, id, partyId, parse(partyBody.partial(), body));
  }
}
