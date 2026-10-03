import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

@Module({
  imports: [CustomersModule, QuotationsModule, MasterDataModule],
  controllers: [BookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
