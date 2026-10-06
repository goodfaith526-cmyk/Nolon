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
import type { CustomerDto, CustomerSummaryDto, Page } from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { AgentReadable, CurrentUser, RequirePermission } from '../auth/decorators.js';
import {
  countryCode,
  optionalText,
  pageQuery,
  parse,
  phone,
  requiredText,
} from '../common/validation.js';
import { createCustomerBody, email, updateCustomerBody } from './customer-schemas.js';
import { CustomersService } from './customers.service.js';

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

  @AgentReadable()
  @Get()
  @RequirePermission('customers:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<Page<CustomerSummaryDto>> {
    return this.customers.list(user, parse(pageQuery, query));
  }

  @AgentReadable()
  @Get(':id')
  @RequirePermission('customers:view')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<CustomerDto> {
    return this.customers.get(user, id);
  }

  @Post()
  @RequirePermission('customers:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<CustomerDto> {
    return this.customers.create(user, parse(createCustomerBody, body));
  }

  @Patch(':id')
  @RequirePermission('customers:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CustomerDto> {
    return this.customers.update(user, id, parse(updateCustomerBody, body));
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
