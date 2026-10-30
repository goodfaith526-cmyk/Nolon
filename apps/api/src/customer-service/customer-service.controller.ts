import { CustomerIdentityFilter } from './customer-identity.filter.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  Req,
  type RawBodyRequest,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CustomerIdentityAuth, identityError } from './customer-identity-auth.js';
import {
  type ApiClientCreatedDto,
  type ApiClientDto,
  CS_BOT_HANDOVERS,
  CS_INVOICE_STATES,
  CS_HANDOVERS,
  CS_REQUEST_SERVICES,
  CS_SCOPES,
  CS_SENDER_CHANNELS,
  CS_SHIPMENT_STATES,
  LOAD_TYPES,
  SHIPPING_MODES,
  type CsBookingRequestCreated,
  type CsBookingRequestDto,
  type CsCatalogDto,
  type CsCustomerDto,
  type CsCustomerTokenAnswer,
  type CsQuoteDto,
  type CsInvoiceDto,
  type CsShipmentDto,
  type CsShipmentSummaryDto,
} from '@nolon/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators.js';
import {
  amount,
  currencyCode,
  dateString,
  parse,
  phone,
  quantity,
  requiredText,
} from '../common/validation.js';
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
import { QuoteService } from './quote.service.js';
import {
  type BookingRequestCaller,
  BookingRequestGuard,
  CurrentBookingCaller,
} from './booking-request.guard.js';
import { BookingRequestsService } from './booking-requests.service.js';

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
const quoteQuery = z
  .object({
    originId: z.uuid(),
    destinationId: z.uuid(),
    category: z.string().trim().min(1).max(20),
    quantity: quantity.optional(),
    mode: z.enum(SHIPPING_MODES).optional(),
    loadType: z.enum(LOAD_TYPES).optional(),
    currency: currencyCode.optional(),
    onDate: dateString.optional(),
  })
  .strict();
const telegramId = z.string().regex(/^[1-9]\d{0,19}$/, 'Telegram user id');
const sender = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('whatsapp'), id: phone }).strict(),
  z.object({ channel: z.literal('telegram'), id: telegramId }).strict(),
]);
const name200 = requiredText(200);
const botName = z.object({ ar: requiredText(200), en: requiredText(200) }).strict();
const digitsPhone = z
  .string()
  .trim()
  .regex(/^\+?\d{6,15}$/, 'Phone digits');
/** A number of pieces as a decimal string or a JSON number (up to 4 decimals), kept as a string. */
const bodyQuantity = z.union([
  quantity,
  z
    .number()
    .positive()
    .max(1e9)
    .refine((n) => /^\d{1,14}(\.\d{1,4})?$/.test(String(n)), 'At most 4 decimals')
    .transform(String),
]);
const requestBody = z
  .object({
    profileId: z.uuid().optional(),
    conversationId: z.string().min(1).max(128).optional(),
    sender: sender.optional(),
    contactPhone: phone.optional(),
    originId: z.uuid(),
    destinationId: z.uuid(),
    category: z.string().trim().min(1).max(20),
    quantity: bodyQuantity,
    services: z
      .array(z.enum(CS_REQUEST_SERVICES))
      .max(CS_REQUEST_SERVICES.length)
      .refine((s) => new Set(s).size === s.length, 'Each service once'),
    senderName: name200,
    consigneeName: name200,
    // The receiver's number as the customer gave it (local or international): contact only, never
    // a proof of anyone, so no country is guessed for it.
    consigneePhone: digitsPhone,
    handover: z.enum(CS_HANDOVERS),
    requestedDate: dateString.optional(),
    quoteRef: z
      .string()
      .regex(/^q_[A-Za-z0-9_-]{32}$/)
      .optional(),
    language: z.enum(['ar', 'en']),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  })
  .strict();
/** A request in the bot's own words (erp-agents #247): names, a number of pieces, its price. */
const namesBody = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    profileId: z.uuid().optional(),
    conversationId: z.string().min(1).max(128).optional(),
    channel: z.enum(CS_SENDER_CHANNELS),
    origin: botName,
    destination: botName,
    kind: botName,
    quantity: bodyQuantity,
    senderName: name200,
    senderPhone: digitsPhone.optional(),
    receiverName: name200,
    receiverPhone: digitsPhone,
    handover: z.enum(CS_BOT_HANDOVERS),
    quotedPrice: z.object({ amount, currency: currencyCode }).strict().nullable().optional(),
  })
  .strict();
/** `X-Cs-Sender: whatsapp:+2499...` or `telegram:123`: the owner a key-only read names. */
function senderHeader(value: string | undefined): z.infer<typeof sender> | null {
  const at = value?.indexOf(':') ?? -1;
  if (!value || at < 0) return null;
  const parsed = sender.safeParse({ channel: value.slice(0, at), id: value.slice(at + 1) });
  return parsed.success && (CS_SENDER_CHANNELS as readonly string[]).includes(parsed.data.channel)
    ? parsed.data
    : null;
}
const scopes = z.array(z.enum(CS_SCOPES)).min(1).max(CS_SCOPES.length);
const services = z.array(z.enum(CS_REQUEST_SERVICES)).max(CS_REQUEST_SERVICES.length);
const createBody = z
  .object({
    name: requiredText(100),
    branchIds: z.array(z.uuid()).min(1).max(20),
    scopes,
    services: services.optional(),
  })
  .strict();
const scopesBody = z.object({ scopes }).strict();
const servicesBody = z.object({ services }).strict();

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
  get(@CurrentApiClient() client: ApiClientAuth): Promise<CsCatalogDto> {
    return this.catalog.catalog(client.services);
  }
}

/** NOLON's price for a route (R2), from its own engine: public prices, so no customer token. */
@Controller('cs/quote')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:quote:read')
export class QuoteController {
  constructor(private readonly quotes: QuoteService) {}

  @Get()
  get(@CurrentApiClient() client: ApiClientAuth, @Query() query: unknown): Promise<CsQuoteDto> {
    return this.quotes.quote(client, parse(quoteQuery, query));
  }
}

/**
 * Booking requests (R3): a draft for staff, never a booking. With a customer token it is that
 * customer's; with the key alone, the sender's it names. Read back by the same owner only.
 */
@Controller('cs/booking-requests')
@Public()
@UseGuards(BookingRequestGuard)
@RequireApiScope('cs:booking_requests:create')
@UseFilters(CustomerIdentityFilter)
export class BookingRequestsController {
  constructor(
    private readonly requests: BookingRequestsService,
    private readonly identityAuth: CustomerIdentityAuth,
  ) {}

  @Post()
  async create(
    @CurrentBookingCaller() caller: BookingRequestCaller,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CsBookingRequestCreated> {
    // Names (origin as { ar, en }) are the bot's form; ids are the catalog's.
    const byNames = typeof body === 'object' && body !== null && 'channel' in body;
    const input = byNames ? parse(namesBody, body) : parse(requestBody, body);
    let binding;
    if (input.profileId || input.conversationId) {
      if (!input.profileId || !input.conversationId || caller.kind !== 'key')
        identityError(400, 'INVALID_INPUT');
      const envelope = this.identityAuth.verify(caller.client.id, req);
      const channel = envelope.context.channel.toLowerCase();
      if (
        ('channel' in input && input.channel !== channel) ||
        ('sender' in input &&
          input.sender &&
          (input.sender.channel !== channel || input.sender.id !== envelope.context.subjectId))
      )
        identityError(401, 'INVALID_CHANNEL_ASSERTION');
      binding = {
        profileId: input.profileId,
        conversationId: input.conversationId,
        context: envelope.context,
      };
    }
    const { created, body: answer } =
      'channel' in input
        ? await this.requests.createByNames(caller, input, binding)
        : await this.requests.create(caller, input, binding);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return answer;
  }

  @Get(':id')
  read(
    @CurrentBookingCaller() caller: BookingRequestCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-cs-sender') sender: string | undefined,
  ): Promise<CsBookingRequestDto> {
    return this.requests.read(caller, id, senderHeader(sender));
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

  @Put(':id/services')
  @RequirePermission('users:update')
  setServices(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ApiClientDto> {
    return this.clients.setServices(user, id, parse(servicesBody, body).services);
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
