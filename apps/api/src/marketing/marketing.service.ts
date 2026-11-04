import { Injectable } from '@nestjs/common';
import type { MarketingSummaryDto } from '@nolon/shared';
import { BillingReportsService } from '../billing/billing-reports.service.js';
import { BookingReportsService } from '../bookings/booking-reports.service.js';
import { todayIn } from '../common/dates.js';
import type { ApiClientAuth } from '../customer-service/api-client.guard.js';
import { BookingRequestReportsService } from '../customer-service/booking-request-reports.service.js';
import { CustomerReportsService } from '../customers/customer-reports.service.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { RatesService } from '../rates/rates.service.js';
import { buildSummary, periodMonths } from './marketing-summary.js';

/**
 * The marketing summary (docs/plans/11-marketing-summary.md): read only, aggregates only. The
 * prices are every branch's approved freight cards valid today, as the bot's quotes read them;
 * requests, bookings and revenue are the key's branches'; new customers count every branch
 * (customers are central). Revenue only for a key holding `cs:marketing:revenue:read`.
 */
@Injectable()
export class MarketingService {
  constructor(
    private readonly masterData: MasterDataService,
    private readonly rates: RatesService,
    private readonly bookings: BookingReportsService,
    private readonly requests: BookingRequestReportsService,
    private readonly billing: BillingReportsService,
    private readonly customers: CustomerReportsService,
  ) {}

  async summary(client: ApiClientAuth, from: string, to: string): Promise<MarketingSummaryDto> {
    const months = periodMonths(from, to);
    const pricesOn = todayIn('UTC');
    const branchIds = client.allowedBranchIds;
    const withRevenue = client.scopes.includes('cs:marketing:revenue:read');
    const [all, prices, requests, bookings, newCustomers, revenue] = await Promise.all([
      this.masterData.all(),
      this.rates.marketingPrices(pricesOn),
      this.requests.marketingMonthly(branchIds, from, to),
      this.bookings.marketingMonthly(branchIds, from, to),
      this.customers.newCustomersByMonth(from, to),
      withRevenue ? this.billing.marketingRevenue(branchIds, from, to) : Promise.resolve(null),
    ]);
    return buildSummary({
      from,
      to,
      pricesOn,
      months,
      locations: all.locations,
      categories: all.priceCategories,
      prices,
      requests,
      bookings,
      newCustomers,
      revenue,
    });
  }
}
