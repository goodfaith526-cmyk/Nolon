import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';
import { MyDraftsController } from './my-drafts.controller.js';
import { MyDraftsService } from './my-drafts.service.js';

@Module({
  imports: [
    BillingModule,
    BookingsModule,
    CustomersModule,
    DraftsModule,
    QuotationsModule,
    RatesModule,
    ShipmentsModule,
    TransportModule,
    WarehouseModule,
  ],
  controllers: [MyDraftsController],
  providers: [MyDraftsService],
  exports: [MyDraftsService],
})
export class MyDraftsModule {}
