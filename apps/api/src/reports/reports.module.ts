import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Financial reports (annex D section 4) and their Excel exports. Read only. */
@Module({
  imports: [AccountingModule, BillingModule, CustomersModule, ShipmentsModule, TransportModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
