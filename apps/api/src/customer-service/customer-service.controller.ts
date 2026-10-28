import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type ApiClientCreatedDto,
  type ApiClientDto,
  CS_INVOICE_STATES,
  CS_SCOPES,
  CS_SHIPMENT_STATES,
  type CsCatalogDto,
  type CsCustomerDto,
  type CsCustomerTokenAnswer,
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
import { RequireApiScope } from './api-scopes.js';
import { CatalogService } from './catalog.service.js';
import { CustomerMeService } from './customer-me.service.js';
import { CustomerServiceService } from './customer-service.service.js';
import {
  type CustomerTokenAuth,
  CurrentCustomerToken,
  CustomerTokenGuard,
} from './customer-token.guard.js';
import { CustomerTokensService } from './customer-tokens.service.js';

const reference = z.string().trim().min(1).max(30);
const phoneQuery = z.object({ phone }).strict();
const limit = z.coerce.number().int().min(1).max(50).default(10);
const shipmentsQuery = z
  .object({ state: z.enum(CS_SHIPMENT_STATES).default('active'), limit })
  .strict();
const invoicesQuery = z
  .object({ state: z.enum(CS_INVOICE_STATES).default('open'), limit })
  .strict();
const tokenBody = z
  .object({
    phone,
    customerNumber: reference.optional(),
    verificationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,200}$/)
      .optional(),
  })
  .strict();
const scopes = z.array(z.enum(CS_SCOPES)).min(1).max(CS_SCOPES.length);
const createBody = z
  .object({ name: requiredText(100), branchIds: z.array(z.uuid()).min(1).max(20), scopes })
  .strict();
const scopesBody = z.object({ scopes }).strict();

/**
 * Customer Service API (scope section 17): read-only, customer-safe, with an API key instead of a
 * staff session (the AI agent and other customer-service clients, AGENTS.md rule 6).
 */
@Controller('cs')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:customers:read')
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

/**
 * Customer tokens (N1): a key with cs:customer_tokens:issue asks for a token for the one customer
 * a channel-verified phone matches. The key reads no customer data itself.
 */
@Controller('cs/customer-tokens')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:customer_tokens:issue')
export class CustomerTokensController {
  constructor(private readonly tokens: CustomerTokensService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  issue(
    @CurrentApiClient() client: ApiClientAuth,
    @Body() body: unknown,
  ): Promise<CsCustomerTokenAnswer> {
    return this.tokens.issue(client, parse(tokenBody, body));
  }
}

/** The places, shipment types and services a bot understands (R1): public master data only. */
@Controller('cs/catalog')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:catalog:read')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  get(): Promise<CsCatalogDto> {
    return this.catalog.catalog();
  }
}

/** One customer's reads with a customer token (N2): the customer comes from the token only. */
@Controller('cs/me')
@Public()
@UseGuards(CustomerTokenGuard)
export class CustomerMeController {
  constructor(private readonly me: CustomerMeService) {}

  @Get('shipments')
  shipments(
    @CurrentCustomerToken() auth: CustomerTokenAuth,
    @Query() query: unknown,
  ): Promise<CsShipmentSummaryDto[]> {
    const q = parse(shipmentsQuery, query);
    return this.me.shipments(auth, q.state, q.limit);
  }

  @Get('shipments/:number')
  shipment(
    @CurrentCustomerToken() auth: CustomerTokenAuth,
    @Param('number') number: string,
  ): Promise<CsShipmentDto> {
    return this.me.shipment(auth, parse(reference, number));
  }

  @Get('invoices')
  invoices(
    @CurrentCustomerToken() auth: CustomerTokenAuth,
    @Query() query: unknown,
  ): Promise<CsInvoiceDto[]> {
    const q = parse(invoicesQuery, query);
    return this.me.invoices(auth, q.state, q.limit);
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

  @Put(':id/scopes')
  @RequirePermission('users:update')
  setScopes(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ApiClientDto> {
    return this.clients.setScopes(user, id, parse(scopesBody, body).scopes);
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
