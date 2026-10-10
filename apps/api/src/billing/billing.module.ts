import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import {
  CreditNotesController,
  CustomerStatementsController,
  InvoicesController,
  ReceiptsController,
} from './billing.controller.js';
import { CreditNotesService } from './credit-notes.service.js';
import { CustomerStatementService } from './customer-statement.service.js';
import { BillingReportsService } from './billing-reports.service.js';
import { InvoiceDraftsController } from './invoice-drafts.controller.js';
import { InvoiceDraftsService } from './invoice-drafts.service.js';
import { InvoicesService } from './invoices.service.js';
import { ReceiptDraftsController } from './receipt-drafts.controller.js';
import { ReceiptDraftsService } from './receipt-drafts.service.js';
import { ReceiptsService } from './receipts.service.js';

@Module({
  imports: [
    AccountingModule,
    CurrenciesModule,
    CustomersModule,
    DraftsModule,
    MasterDataModule,
    QuotationsModule,
    ShipmentsModule,
  ],
  controllers: [
    InvoicesController,
    ReceiptsController,
    CreditNotesController,
    CustomerStatementsController,
    InvoiceDraftsController,
    ReceiptDraftsController,
  ],
  providers: [
    InvoicesService,
    ReceiptsService,
    CreditNotesService,
    BillingReportsService,
    CustomerStatementService,
    InvoiceDraftsService,
    ReceiptDraftsService,
  ],
  exports: [BillingReportsService],
})
export class BillingModule {}
