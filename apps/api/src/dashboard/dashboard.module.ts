import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [CustomersModule, RatesModule, QuotationsModule, BookingsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
