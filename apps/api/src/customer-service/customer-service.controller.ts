import { CustomerIdentityFilter } from './customer-identity.filter.js';
import {
  BadRequestException,
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
  StreamableFile,
  Req,
  type RawBodyRequest,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CustomerIdentityAuth, identityError } from './customer-identity-auth.js';
import { senderChannelOf, senderIdOf } from './customer-identity.contract.js';
import {
  type ApiClientCreatedDto,
  type ApiClientDto,
  CS_BOT_HANDOVERS,
  CS_INVOICE_STATES,
  CS_HANDOVERS,
  CS_OTHER_KIND,
  CS_REQUEST_ITEMS_MAX,
  CS_REQUEST_SERVICES,
  CS_SCOPES,
  CS_SENDER_CHANNELS,
  CS_SHIPMENT_STATES,
  LOAD_TYPES,
  SHIPPING_MODES,
  type CsBookingRequestCancelled,
  type CsEstimateAccepted,
  type CsPhotoUploaded,
  type CsBookingRequestCreated,
  type CsBookingRequestDto,
  type CsOwnBookingRequestDto,
  type CsCatalogDto,
  type CsCustomerDto,
  type CsCustomerTokenAnswer,
  type CsQuotationSaved,
  type CsQuoteDto,
  type CsQuotesDto,
  type CsInvoiceDto,
  type CsShipmentDto,
  type CsStatementDto,
  type CsShipmentSummaryDto,
  type CsWebhooksDto,
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
import { CsWebhooksService } from './cs-webhooks.service.js';
import { RequireApiScope } from './api-scopes.js';
import { CatalogService } from './catalog.service.js';
import { CustomerMeService } from './customer-me.service.js';
import { CustomerStatementService } from './customer-statement.service.js';
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
import { BotQuotationsService } from './bot-quotations.service.js';

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
    /** Plan 14-1: with a signed Telegram assertion only. */
    phoneEvidence: z
      .object({
        kind: z.literal('TELEGRAM_OWN_CONTACT'),
        contactUserId: z.string().regex(/^[1-9]\d{0,31}$/),
        value: phone,
      })
      .strict()
      .optional(),
  })
  .strict();
/** One piece's dimension in centimetres, positive, up to 2 decimals: Decimal(10, 2), as bookings. */
const dimensionCm = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, 'Invalid measurement')
  .refine((v) => /[1-9]/.test(v), 'Must be positive');
/** The pieces a volume request's CBM came from: a whole number, as a booking item's quantity. */
const pieces = z.number().int().min(1).max(100_000);
const quoteQuery = z
  .object({
    originId: z.uuid(),
    destinationId: z.uuid(),
    category: z.string().trim().min(1).max(20),
    quantity: quantity.optional(),
    lengthCm: dimensionCm.optional(),
    widthCm: dimensionCm.optional(),
    heightCm: dimensionCm.optional(),
    mode: z.enum(SHIPPING_MODES).optional(),
    loadType: z.enum(LOAD_TYPES).optional(),
    currency: currencyCode.optional(),
    onDate: dateString.optional(),
  })
  .strict();
// Plan 09 section 4: POST /cs/quotes, the route common and 1 to 10 items.
const quotesBody = quoteQuery
  .omit({ category: true, quantity: true, lengthCm: true, widthCm: true, heightCm: true })
  .extend({
    items: z
      .array(
        quoteQuery.pick({
          category: true,
          quantity: true,
          lengthCm: true,
          widthCm: true,
          heightCm: true,
        }),
      )
      .min(1)
      .max(CS_REQUEST_ITEMS_MAX),
  })
  .strict();
const telegramId = z.string().regex(/^[1-9]\d{0,19}$/, 'Telegram user id');
/** A web chat visitor: 16 random hex digits the agent's site session issued (no phone, no account). */
const webVisitorId = z.string().regex(/^[0-9a-f]{16}$/, 'Web chat visitor id');
const sender = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('whatsapp'), id: phone }).strict(),
  z.object({ channel: z.literal('telegram'), id: telegramId }).strict(),
  z.object({ channel: z.literal('web'), id: webVisitorId }).strict(),
]);
const name200 = requiredText(200);
/** Plan 09e section 2: an explicit other sender, with an international phone. */
const otherSender = z.object({ name: name200, phone }).strict();
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
/** A total weight in kilograms, positive, up to 3 decimals: Decimal(12, 3), as booking lines. */
const weightKg = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'Invalid weight')
  .refine((v) => /[1-9]/.test(v), 'Must be positive');
const measures = {
  pieces: pieces.optional(),
  lengthCm: dimensionCm.optional(),
  widthCm: dimensionCm.optional(),
  heightCm: dimensionCm.optional(),
  weightKg: weightKg.optional(),
};
/** Plan 09 section 12: an item outside the standard categories, in the customer's words. */
const otherItem = z
  .object({ kind: z.literal(CS_OTHER_KIND), description: requiredText(500), ...measures })
  .strict();
const quoteRefField = z.string().regex(/^q_[A-Za-z0-9_-]{32}$/);
const idsItem = z.union([
  z
    .object({
      category: z.string().trim().min(1).max(20),
      quantity: bodyQuantity,
      quoteRef: quoteRefField.optional(),
      ...measures,
    })
    .strict(),
  otherItem,
]);
const botName = z.object({ ar: requiredText(200), en: requiredText(200) }).strict();
const namesItem = z.union([
  z.object({ kind: botName, quantity: bodyQuantity, ...measures }).strict(),
  otherItem,
]);
/**
 * Codex F167-2: one piece's three dimensions come together or not at all, as a booking line takes
 * them. A partial set is refused at intake, naming the missing fields so the bot asks for them;
 * nothing is guessed.
 */
function requireWholeDimensions(
  items: readonly { lengthCm?: string; widthCm?: string; heightCm?: string }[],
): void {
  const fields = items.flatMap((item, index) => {
    const given = (['lengthCm', 'widthCm', 'heightCm'] as const).filter(
      (f) => item[f] !== undefined,
    );
    if (given.length === 0 || given.length === 3) return [];
    return (['lengthCm', 'widthCm', 'heightCm'] as const)
      .filter((f) => item[f] === undefined)
      .map((f) => `items.${index}.${f}`);
  });
  if (fields.length > 0)
    throw new BadRequestException({
      code: 'DIMENSIONS_TOGETHER',
      message: 'Send lengthCm, widthCm and heightCm together, or none of them',
      fields,
    });
}
const itemsField = <T extends z.ZodType>(item: T) =>
  z.array(item).min(1).max(CS_REQUEST_ITEMS_MAX).optional();
/** Plan 09 section 4: `items`, or the one-item shape, never both and never neither. */
function oneShape(v: { items?: unknown[]; quantity?: unknown }, single: unknown): boolean {
  return v.items === undefined
    ? single !== undefined && v.quantity !== undefined
    : single === undefined && v.quantity === undefined;
}
const requestBody = z
  .object({
    profileId: z.uuid().optional(),
    conversationId: z.string().min(1).max(128).optional(),
    profileVersion: z.number().int().min(1).optional(),
    sender: sender.optional(),
    contactPhone: phone.optional(),
    originId: z.uuid(),
    destinationId: z.uuid(),
    category: z.string().trim().min(1).max(20).optional(),
    quantity: bodyQuantity.optional(),
    items: itemsField(idsItem),
    pieces: pieces.optional(),
    lengthCm: dimensionCm.optional(),
    widthCm: dimensionCm.optional(),
    heightCm: dimensionCm.optional(),
    services: z
      .array(z.enum(CS_REQUEST_SERVICES))
      .max(CS_REQUEST_SERVICES.length)
      .refine((s) => new Set(s).size === s.length, 'Each service once'),
    otherSender: otherSender.optional(),
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
  .strict()
  .refine((v) => oneShape(v, v.category), {
    message: 'Send items, or category and quantity, not both',
    params: { code: 'ITEMS_AND_SINGLE' },
  })
  .refine(
    (v) =>
      v.items === undefined ||
      (v.pieces === undefined && v.lengthCm === undefined && v.quoteRef === undefined),
    { message: 'With items, pieces, dimensions and quoteRef go on each item' },
  );
/** A request in the bot's own words (erp-agents #247): names, a number of pieces, its price. */
const namesBody = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    profileId: z.uuid().optional(),
    conversationId: z.string().min(1).max(128).optional(),
    profileVersion: z.number().int().min(1).optional(),
    channel: z.enum(CS_SENDER_CHANNELS),
    origin: botName,
    destination: botName,
    kind: botName.optional(),
    quantity: bodyQuantity.optional(),
    items: itemsField(namesItem),
    otherSender: otherSender.optional(),
    senderName: name200,
    senderPhone: digitsPhone.optional(),
    receiverName: name200,
    receiverPhone: digitsPhone,
    handover: z.enum(CS_BOT_HANDOVERS),
    quotedPrice: z.object({ amount, currency: currencyCode }).strict().nullable().optional(),
  })
  .strict()
  .refine((v) => oneShape(v, v.kind), {
    message: 'Send items, or kind and quantity, not both',
    params: { code: 'ITEMS_AND_SINGLE' },
  });
/** `X-Cs-Sender: whatsapp:+2499...`, `telegram:123` or `web:<16 hex>`: the owner a key-only read names. */
function senderHeader(value: string | undefined): z.infer<typeof sender> | null {
  const at = value?.indexOf(':') ?? -1;
  if (!value || at < 0) return null;
  const parsed = sender.safeParse({ channel: value.slice(0, at), id: value.slice(at + 1) });
  return parsed.success && (CS_SENDER_CHANNELS as readonly string[]).includes(parsed.data.channel)
    ? parsed.data
    : null;
}
const cancelBody = z.object({ reason: requiredText(300).optional() }).strict();
const listQuery = z.object({ limit }).strict();
const acceptEstimateBody = z.object({ estimateVersion: z.number().int().min(1) }).strict();
/** Plan 09 section 12: the photo's idempotency key, as the signed identity covers it. */
const photoKey = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/);
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

/** Plan 09 section 5: an endpoint the key's bot receives notices at (checked by the service). */
const webhookBody = z
  .object({
    url: z.string().trim().min(1).max(500),
    audience: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/),
  })
  .strict();

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
  constructor(
    private readonly tokens: CustomerTokensService,
    private readonly identityAuth: CustomerIdentityAuth,
  ) {}

  /**
   * Without a channel assertion: WhatsApp, as before. With one (plan 14-1): a Telegram sender's
   * own shared contact, checked by the signed assertion; `phoneEvidence` without one is 400.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  issue(
    @CurrentApiClient() client: ApiClientAuth,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CsCustomerTokenAnswer> {
    const input = parse(tokenBody, body);
    if (req.get('X-Nolon-Channel-Assertion') === undefined) {
      if (input.phoneEvidence) {
        throw new BadRequestException({
          message: 'phoneEvidence needs a signed channel assertion',
          code: 'ASSERTION_REQUIRED',
          error: 'Bad Request',
          statusCode: 400,
        });
      }
      return this.tokens.issue(client, input);
    }
    this.tokens.requireTelegram();
    return this.tokens.issueTelegram(
      client,
      input,
      () => this.identityAuth.verify(client.id, req).context,
    );
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
    return this.catalog.catalog(client.services, client.allowedBranchIds);
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

/** Plan 09 section 4: the price of several items of one route, item by item, with their sum. */
@Controller('cs/quotes')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:quote:read')
export class QuotesController {
  constructor(private readonly quotes: QuoteService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  quote(@CurrentApiClient() client: ApiClientAuth, @Body() body: unknown): Promise<CsQuotesDto> {
    return this.quotes.quoteMany(client, parse(quotesBody, body));
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
    // Plan 09 section 4: items or the one-item shape, never both, refused with its own code.
    if (
      typeof body === 'object' &&
      body !== null &&
      'items' in body &&
      ['category', 'kind', 'quantity'].some((field) => field in body)
    )
      throw new BadRequestException({
        code: 'ITEMS_AND_SINGLE',
        message: 'Send items, or the one-item fields, not both',
      });
    const input = byNames ? parse(namesBody, body) : parse(requestBody, body);
    requireWholeDimensions(input.items ?? []);
    let binding;
    if (input.profileId || input.conversationId || input.profileVersion !== undefined) {
      if (!input.profileId || !input.conversationId || caller.kind !== 'key')
        identityError(400, 'INVALID_INPUT');
      const envelope = this.identityAuth.verify(caller.client.id, req);
      const channel = envelope.context.channel.toLowerCase();
      if (
        ('channel' in input && input.channel !== channel) ||
        ('sender' in input &&
          input.sender &&
          (input.sender.channel !== channel || input.sender.id !== senderIdOf(envelope.context)))
      )
        identityError(401, 'INVALID_CHANNEL_ASSERTION');
      binding = {
        profileId: input.profileId,
        conversationId: input.conversationId,
        profileVersion: input.profileVersion,
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

  /**
   * The proven owner's requests, newest first (owner 2026-11-05): a customer token, or the key with
   * a signed channel identity of the sender; the key alone is 403 OWNER_PROOF_REQUIRED.
   */
  @Get()
  list(
    @CurrentBookingCaller() caller: BookingRequestCaller,
    @Query() query: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CsOwnBookingRequestDto[]> {
    const q = parse(listQuery, query);
    return this.requests.list(caller, this.proofOf(caller, req), q.limit);
  }

  @Get(':id')
  read(
    @CurrentBookingCaller() caller: BookingRequestCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-cs-sender') sender: string | undefined,
  ): Promise<CsBookingRequestDto> {
    return this.requests.read(caller, id, senderHeader(sender));
  }

  /** Plan 09 section 2: the owner cancels its request while staff have not decided it. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentBookingCaller() caller: BookingRequestCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CsBookingRequestCancelled> {
    const input = parse(cancelBody, body ?? {});
    return this.requests.cancel(caller, id, this.proofOf(caller, req), input.reason);
  }

  /**
   * Plan 09 section 12: the owner sends one photo for staff, as the raw body (JPEG, PNG or WebP,
   * at most 10 MB), with an Idempotency-Key. 201 when added, 200 when the same photo again.
   */
  @Post(':id/photos')
  async addPhoto(
    @CurrentBookingCaller() caller: BookingRequestCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CsPhotoUploaded> {
    const idempotencyKey = parse(photoKey, key);
    const bytes = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    const { created, body } = await this.requests.addPhoto(
      caller,
      id,
      this.proofOf(caller, req),
      idempotencyKey,
      bytes,
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return body;
  }

  /** Plan 09 section 12: the owner accepts the estimate version it was shown. */
  @Post(':id/accept-estimate')
  @HttpCode(HttpStatus.OK)
  acceptEstimate(
    @CurrentBookingCaller() caller: BookingRequestCaller,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CsEstimateAccepted> {
    const input = parse(acceptEstimateBody, body);
    return this.requests.acceptEstimate(
      caller,
      id,
      this.proofOf(caller, req),
      input.estimateVersion,
    );
  }

  /** The owner's proof: the customer token, or a signed channel identity (plan 08) of the sender. */
  private proofOf(
    caller: BookingRequestCaller,
    req: RawBodyRequest<Request>,
  ): { channel: 'whatsapp' | 'telegram' | 'web'; subjectId: string } | null {
    const signed =
      caller.kind === 'key' && req.get('X-Nolon-Channel-Assertion') !== undefined
        ? this.identityAuth.verify(caller.client.id, req).context
        : null;
    return signed
      ? {
          channel: senderChannelOf(signed.channel),
          subjectId: senderIdOf(signed),
        }
      : null;
  }
}

const quotationSaveBody = z
  .object({ quoteRefs: z.array(quoteRefField).min(1).max(CS_REQUEST_ITEMS_MAX) })
  .strict();

/**
 * Owner, 2026-11-05: the prices the bot gave its customer, saved in Quotations. The customer is
 * proven as for listing requests: a customer token, or the key with a signed channel identity of
 * the sender (plan 08); the key alone is 403 OWNER_PROOF_REQUIRED. 201 when saved, 200 when the
 * same quotes were saved before.
 */
@Controller('cs/quotations')
@Public()
@UseGuards(BookingRequestGuard)
@RequireApiScope('cs:booking_requests:create')
@UseFilters(CustomerIdentityFilter)
export class QuotationSaveController {
  constructor(
    private readonly quotations: BotQuotationsService,
    private readonly identityAuth: CustomerIdentityAuth,
  ) {}

  @Post()
  async save(
    @CurrentBookingCaller() caller: BookingRequestCaller,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CsQuotationSaved> {
    const input = parse(quotationSaveBody, body);
    const proof =
      caller.kind === 'key' && req.get('X-Nolon-Channel-Assertion') !== undefined
        ? this.identityAuth.verify(caller.client.id, req).context
        : null;
    const { created, body: answer } = await this.quotations.save(
      caller,
      proof ? { channel: proof.channel, subjectId: proof.subjectId } : null,
      input.quoteRefs,
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return answer;
  }
}

/** One customer's reads with a customer token (N2): the customer comes from the token only. */
@Controller('cs/me')
@Public()
@UseGuards(CustomerTokenGuard)
export class CustomerMeController {
  constructor(
    private readonly me: CustomerMeService,
    private readonly statements: CustomerStatementService,
  ) {}

  /** Plan 14-2: the customer's statement for a period (query checked, and logged, by the service). */
  @Get('statement')
  statement(
    @CurrentCustomerToken() auth: CustomerTokenAuth,
    @Query() query: unknown,
  ): Promise<CsStatementDto> {
    return this.statements.statement(auth, query);
  }

  /** Plan 14-3: the same statement as a NOLON PDF, rendered on request, never stored. */
  @Get('statement/pdf')
  async statementPdf(
    @CurrentCustomerToken() auth: CustomerTokenAuth,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { bytes, filename } = await this.statements.pdf(auth, query);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
      length: bytes.byteLength,
    });
  }

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
  constructor(
    private readonly clients: ApiClientsService,
    private readonly webhooks: CsWebhooksService,
  ) {}

  @Get(':id/webhooks')
  @RequirePermission('users:view')
  listWebhooks(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CsWebhooksDto> {
    return this.webhooks.view(user, id);
  }

  @Post(':id/webhooks')
  @RequirePermission('users:create')
  addWebhook(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<CsWebhooksDto> {
    return this.webhooks.create(user, id, parse(webhookBody, body));
  }

  @Post(':id/webhooks/:endpointId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users:update')
  approveWebhook(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
  ): Promise<CsWebhooksDto> {
    return this.webhooks.approve(user, id, endpointId);
  }

  @Post(':id/webhooks/:endpointId/retire')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users:update')
  retireWebhook(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
  ): Promise<CsWebhooksDto> {
    return this.webhooks.retire(user, id, endpointId);
  }

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
