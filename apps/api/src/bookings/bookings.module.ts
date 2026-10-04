import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { BookingReportsService } from './booking-reports.service.js';

@Module({
  imports: [CustomersModule, QuotationsModule, MasterDataModule, ShipmentsModule],
  controllers: [BookingsController],
  providers: [BookingReportsService, BookingsService],
  exports: [BookingReportsService, BookingsService],
})
export class BookingsModule {}
