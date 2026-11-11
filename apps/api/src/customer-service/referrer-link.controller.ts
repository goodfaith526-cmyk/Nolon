import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseFilters,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { ReferrerChannelsService } from '../partners/referrer-channels.service.js';
import { ApiClientGuard, CurrentApiClient, type ApiClientAuth } from './api-client.guard.js';
import { RequireApiScope } from './api-scopes.js';
import {
  CustomerIdentityAuth,
  identityError,
  parseIdentity as parse,
} from './customer-identity-auth.js';
import { identityKey, identitySender } from './customer-identity.contract.js';
import { CustomerIdentityFilter } from './customer-identity.filter.js';

const linkBody = z.object({ token: z.string().min(1).max(64), identity: identitySender }).strict();

const STATUS = {
  REFERRER_LINK_UNKNOWN: 404,
  REFERRER_LINK_USED: 409,
  REFERRER_LINK_EXPIRED: 410,
} as const;

/**
 * Plan 18, 5 (contract with erp-agents, section 7): the bot binds the chat account that opened a
 * broker's private link (`ag_` + 32). Signed like a capture (the sender's channel assertion), with
 * the key's `cs:referrers:link` scope. 200 `{ status: 'LINKED', firstName }`; 404
 * REFERRER_LINK_UNKNOWN, 409 REFERRER_LINK_USED, 410 REFERRER_LINK_EXPIRED.
 */
@Controller('cs/referrers')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:referrers:link')
@UseFilters(CustomerIdentityFilter)
export class ReferrerLinkController {
  constructor(
    private readonly channels: ReferrerChannelsService,
    private readonly auth: CustomerIdentityAuth,
  ) {}

  @Post('link')
  @HttpCode(HttpStatus.OK)
  async link(
    @CurrentApiClient() client: ApiClientAuth,
    @Body() unknown: unknown,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ status: 'LINKED'; firstName: string }> {
    const body = parse(linkBody, unknown);
    const envelope = this.auth.verify(client.id, req, body.identity);
    parse(identityKey, envelope.idempotencyKey);
    const result = await this.channels.link(client.id, body.token, {
      channel: envelope.context.channel,
      subjectId: envelope.context.subjectId,
    });
    if ('refusal' in result) identityError(STATUS[result.refusal], result.refusal);
    return { status: 'LINKED', firstName: result.firstName };
  }
}
