import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { CustomsModule } from '../customs/customs.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';
import { OperationalReportsController } from './operational-reports.controller.js';
import { OperationalReportsService } from './operational-reports.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/**
 * Financial (annex D section 4) and operational (section 3) reports and their Excel exports.
 * Read only.
 */
@Module({
  imports: [
    AccountingModule,
    BillingModule,
    BookingsModule,
    CustomersModule,
    CustomsModule,
    DocumentsModule,
    QuotationsModule,
    ShipmentsModule,
    TransportModule,
    WarehouseModule,
  ],
  controllers: [ReportsController, OperationalReportsController],
  providers: [ReportsService, OperationalReportsService],
})
export class ReportsModule {}
