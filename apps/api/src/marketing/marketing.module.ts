import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CustomerServiceModule } from '../customer-service/customer-service.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { MarketingController } from './marketing.controller.js';
import { MarketingService } from './marketing.service.js';

/** The marketing summary (docs/plans/11): read only, for the marketing agent's API key. */
@Module({
  imports: [
    BillingModule,
    BookingsModule,
    CustomerServiceModule,
    CustomersModule,
    MasterDataModule,
    RatesModule,
  ],
  controllers: [MarketingController],
  providers: [MarketingService],
})
export class MarketingModule {}
