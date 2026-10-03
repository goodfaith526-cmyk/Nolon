import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { PublicTrackingDto, PublicTrackingLookupResponse } from '@nolon/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { parse } from '../common/validation.js';
import { PublicTrackingService } from './public-tracking.service.js';

const tokenParam = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);

const lookupBody = z
  .object({
    reference: z.string().trim().min(5).max(30),
    phoneLast4: z.string().regex(/^[0-9]{4}$/),
  })
  .strict();

/** Public Tracking API: no sign-in, safe fields only, rate-limited (see the service). */
@Controller('public/tracking')
export class PublicTrackingController {
  constructor(private readonly tracking: PublicTrackingService) {}

  @Public()
  @Get(':token')
  byToken(@Param('token') token: string, @Req() req: Request): Promise<PublicTrackingDto> {
    return this.tracking.byToken(parse(tokenParam, token), req.ip);
  }

  @Public()
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  lookup(@Body() body: unknown, @Req() req: Request): Promise<PublicTrackingLookupResponse> {
    const { reference, phoneLast4 } = parse(lookupBody, body);
    return this.tracking.lookup(reference, phoneLast4, req.ip);
  }
}
