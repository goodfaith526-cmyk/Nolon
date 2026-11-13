import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CS_SENDER_CHANNELS, type CsHandoffCreated, type CsHandoffRequestDto } from '@nolon/shared';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Public, RequirePermission } from '../auth/decorators.js';
import { parse, requiredText } from '../common/validation.js';
import { type ApiClientAuth, ApiClientGuard, CurrentApiClient } from './api-client.guard.js';
import { RequireApiScope } from './api-scopes.js';
import { HandoffRequestsService } from './handoff-requests.service.js';

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

const handoffBody = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    channel: z.enum(CS_SENDER_CHANNELS),
    /** The customer's id in the channel, as on booking requests (phone, Telegram id, visitor id). */
    sender: z.string().regex(/^\+?[A-Za-z0-9_-]{1,64}$/),
    customerName: optionalText(200),
    customerPhone: z
      .string()
      .trim()
      .regex(/^\+?\d{6,15}$/, 'Phone digits')
      .optional(),
    reason: requiredText(300),
    bookingRequestRef: z
      .string()
      .regex(/^[A-Z0-9-]{1,20}$/)
      .optional(),
    branchHint: optionalText(100),
  })
  .strict();

const listQuery = z.object({ state: z.enum(['open', 'all']).default('open') }).strict();

/**
 * 2026-11-12: the bot tells staff that a customer wants a person (scope
 * `cs:handoff_requests:create`). 201 `{ id, status: 'open' }` when made, 200 with the same body for
 * a replay of the same idempotency key, 409 IDEMPOTENCY_CONFLICT when the key carried other content.
 */
@Controller('cs/handoff-requests')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:handoff_requests:create')
export class HandoffRequestsController {
  constructor(private readonly handoffs: HandoffRequestsService) {}

  @Post()
  async create(
    @CurrentApiClient() client: ApiClientAuth,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CsHandoffCreated> {
    const result = await this.handoffs.create(client, parse(handoffBody, body));
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.body;
  }

  @Get(':id')
  status(
    @CurrentApiClient() client: ApiClientAuth,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CsHandoffCreated> {
    return this.handoffs.status(client, id);
  }
}

/** «طلبات التواصل»: staff who see the bot's booking requests see these, in their branches. */
@Controller('cs-handoff-requests')
export class HandoffReviewController {
  constructor(private readonly handoffs: HandoffRequestsService) {}

  @Get()
  @RequirePermission('cs_booking_requests:view')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown): Promise<CsHandoffRequestDto[]> {
    return this.handoffs.list(user, parse(listQuery, query).state);
  }

  @Post(':id/contacted')
  @RequirePermission('cs_booking_requests:update')
  contacted(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CsHandoffRequestDto> {
    return this.handoffs.markContacted(user, id);
  }
}
