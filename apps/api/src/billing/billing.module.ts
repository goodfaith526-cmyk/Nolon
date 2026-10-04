import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { InvoicesController, ReceiptsController } from './billing.controller.js';
import { BillingReportsService } from './billing-reports.service.js';
import { InvoicesService } from './invoices.service.js';
import { ReceiptsService } from './receipts.service.js';

@Module({
  imports: [
    AccountingModule,
    CurrenciesModule,
    CustomersModule,
    MasterDataModule,
    QuotationsModule,
    ShipmentsModule,
  ],
  controllers: [InvoicesController, ReceiptsController],
  providers: [InvoicesService, ReceiptsService, BillingReportsService],
  exports: [BillingReportsService],
})
export class BillingModule {}
