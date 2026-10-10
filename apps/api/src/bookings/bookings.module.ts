import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { BookingDraftsController } from './booking-drafts.controller.js';
import { BookingDraftsService } from './booking-drafts.service.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { BookingReportsService } from './booking-reports.service.js';

@Module({
  imports: [CustomersModule, QuotationsModule, MasterDataModule, ShipmentsModule, DraftsModule],
  controllers: [BookingsController, BookingDraftsController],
  providers: [BookingReportsService, BookingsService, BookingDraftsService],
  exports: [BookingReportsService, BookingsService],
})
export class BookingsModule {}
