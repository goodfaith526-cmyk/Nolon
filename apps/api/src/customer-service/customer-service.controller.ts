import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type ApiClientCreatedDto,
  type ApiClientDto,
  CS_INVOICE_STATES,
  CS_SHIPMENT_STATES,
  type CsCustomerDto,
  type CsInvoiceDto,
  type CsShipmentDto,
  type CsShipmentSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators.js';
import { parse, phone, requiredText } from '../common/validation.js';
import { type ApiClientAuth, ApiClientGuard, CurrentApiClient } from './api-client.guard.js';
import { ApiClientsService } from './api-clients.service.js';
import { CustomerServiceService } from './customer-service.service.js';

const reference = z.string().trim().min(1).max(30);
const phoneQuery = z.object({ phone }).strict();
const limit = z.coerce.number().int().min(1).max(50).default(10);
const shipmentsQuery = z
  .object({ state: z.enum(CS_SHIPMENT_STATES).default('active'), limit })
  .strict();
const invoicesQuery = z
  .object({ state: z.enum(CS_INVOICE_STATES).default('open'), limit })
  .strict();
const createBody = z
  .object({ name: requiredText(100), branchIds: z.array(z.uuid()).min(1).max(20) })
  .strict();

/**
 * Customer Service API (scope section 17): read-only, customer-safe, with an API key instead of a
 * staff session (the AI agent and other customer-service clients, AGENTS.md rule 6).
 */
@Controller('cs')
@Public()
@UseGuards(ApiClientGuard)
export class CustomerServiceController {
  constructor(private readonly cs: CustomerServiceService) {}

  @Get('customers')
  byPhone(
    @CurrentApiClient() client: ApiClientAuth,
    @Query() query: unknown,
  ): Promise<CsCustomerDto[]> {
    return this.cs.byPhone(client, parse(phoneQuery, query).phone);
  }

  @Get('customers/:number')
  customer(
    @CurrentApiClient() client: ApiClientAuth,
    @Param('number') number: string,
  ): Promise<CsCustomerDto> {
    return this.cs.customer(client, parse(reference, number));
  }

  @Get('customers/:number/shipments')
  shipments(
    @CurrentApiClient() client: ApiClientAuth,
    @Param('number') number: string,
    @Query() query: unknown,
  ): Promise<CsShipmentSummaryDto[]> {
    const q = parse(shipmentsQuery, query);
    return this.cs.shipments(client, parse(reference, number), q.state, q.limit);
  }

  @Get('customers/:number/invoices')
  invoices(
    @CurrentApiClient() client: ApiClientAuth,
    @Param('number') number: string,
    @Query() query: unknown,
  ): Promise<CsInvoiceDto[]> {
    const q = parse(invoicesQuery, query);
    return this.cs.invoices(client, parse(reference, number), q.state, q.limit);
  }

  @Get('shipments/:number')
  shipment(
    @CurrentApiClient() client: ApiClientAuth,
    @Param('number') number: string,
  ): Promise<CsShipmentDto> {
    return this.cs.shipment(client, parse(reference, number));
  }
}

/** The Administrator's Customer Service API keys. */
@Controller('api-clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get()
  @RequirePermission('users:view')
  list(): Promise<ApiClientDto[]> {
    return this.clients.list();
  }

  @Post()
  @RequirePermission('users:create')
  create(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<ApiClientCreatedDto> {
    return this.clients.create(user, parse(createBody, body));
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users:update')
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApiClientDto> {
    return this.clients.revoke(user, id);
  }
}
