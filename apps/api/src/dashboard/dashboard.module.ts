import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AlertsModule } from '../alerts/alerts.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { CustomsModule } from '../customs/customs.module.js';
import { MyDraftsModule } from '../my-drafts/my-drafts.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';
import { DashboardFiguresService } from './dashboard-figures.service.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [
    CustomersModule,
    RatesModule,
    QuotationsModule,
    BookingsModule,
    ShipmentsModule,
    AccountingModule,
    BillingModule,
    WarehouseModule,
    TransportModule,
    CustomsModule,
    MyDraftsModule,
    AlertsModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardFiguresService],
})
export class DashboardModule {}
