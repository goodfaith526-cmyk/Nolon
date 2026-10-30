import { CustomerIdentityFilter } from './customer-identity.filter.js';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseFilters,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { MasterDataService } from '../master-data/master-data.service.js';
import { Public } from '../auth/decorators.js';

import { ApiClientGuard, CurrentApiClient, type ApiClientAuth } from './api-client.guard.js';
import { RequireApiScope } from './api-scopes.js';
import { CustomerIdentityAuth, parseIdentity as parse } from './customer-identity-auth.js';
import {
  captureIdentityBody,
  updateIdentityBody,
  followUpIdentityBody,
  identityKey,
  selfIdentityQuery,
} from './customer-identity.contract.js';
import { CustomerIdentityService } from './customer-identity.service.js';

@Controller('cs')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:customer_profiles:write')
@UseFilters(CustomerIdentityFilter)
export class CustomerIdentityController {
  constructor(
    private readonly identity: CustomerIdentityService,
    private readonly auth: CustomerIdentityAuth,
    private readonly masterData: MasterDataService,
  ) {}

  @Get('customer-profiles/self')
  self(
    @CurrentApiClient() client: ApiClientAuth,
    @Query() query: unknown,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parse(selfIdentityQuery, query);
    const envelope = this.auth.verify(client.id, req);
    res.setHeader('Cache-Control', 'no-store');
    return this.identity.self(client.id, input.conversationId, envelope);
  }

  @Get('customer-profiles/residence-cities')
  async cities(
    @CurrentApiClient() client: ApiClientAuth,
    @Query() query: unknown,
    @Req() req: RawBodyRequest<Request>,
  ) {
    this.auth.verify(client.id, req);
    const input = parse(
      z
        .object({
          q: z.string().trim().min(2).max(100).optional(),
          countryCode: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
          page: z.coerce.number().int().min(1).max(10000).default(1),
        })
        .strict(),
      query,
    );
    return this.masterData.residenceCities(input);
  }

  @Post('customer-profiles/capture')
  async capture(
    @CurrentApiClient() client: ApiClientAuth,
    @Body() unknown: unknown,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parse(captureIdentityBody, unknown);
    const envelope = this.auth.verify(client.id, req, body.sender);
    parse(identityKey, envelope.idempotencyKey);
    const result = await this.identity.write(client.id, envelope, body);
    res.status(result.created ? 201 : 200);
    return result.body;
  }

  @Patch('customer-profiles/:id')
  update(
    @CurrentApiClient() client: ApiClientAuth,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() unknown: unknown,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const body = parse(updateIdentityBody, unknown);
    const envelope = this.auth.verify(client.id, req, body.sender);
    parse(identityKey, envelope.idempotencyKey);
    return this.identity.write(client.id, envelope, body, id).then((r) => r.body);
  }

  @Post('customer-profiles/:id/follow-up')
  async followUp(
    @CurrentApiClient() client: ApiClientAuth,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() unknown: unknown,
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = parse(followUpIdentityBody, unknown);
    const envelope = this.auth.verify(client.id, req, body.sender);
    parse(identityKey, envelope.idempotencyKey);
    const result = await this.identity.write(client.id, envelope, body, id);
    res.status(200);
    return result.body;
  }

  @Get('customer-profile-operations/:id')
  result(
    @CurrentApiClient() client: ApiClientAuth,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.identity.result(client.id, id, this.auth.verify(client.id, req));
  }
}
