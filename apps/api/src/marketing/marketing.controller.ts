import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { MarketingSummaryDto } from '@nolon/shared';
import { z } from 'zod';
import { Public } from '../auth/decorators.js';
import { dateString, parse } from '../common/validation.js';
import {
  type ApiClientAuth,
  ApiClientGuard,
  CurrentApiClient,
} from '../customer-service/api-client.guard.js';
import { RequireApiScope } from '../customer-service/api-scopes.js';
import { MarketingService } from './marketing.service.js';

const summaryQuery = z.object({ from: dateString, to: dateString }).strict();

/**
 * The marketing agent's read (docs/plans/11): one GET, by an API key holding `cs:marketing:read`.
 * Aggregates only; no write route.
 */
@Controller('marketing')
@Public()
@UseGuards(ApiClientGuard)
@RequireApiScope('cs:marketing:read')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('summary')
  summary(
    @CurrentApiClient() client: ApiClientAuth,
    @Query() query: unknown,
  ): Promise<MarketingSummaryDto> {
    const { from, to } = parse(summaryQuery, query);
    return this.marketing.summary(client, from, to);
  }
}
