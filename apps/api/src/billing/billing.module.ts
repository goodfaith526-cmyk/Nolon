import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import {
  CreditNotesController,
  CustomerCreditController,
  CustomerStatementsController,
  InvoicesController,
  ReceiptsController,
} from './billing.controller.js';
import { AutoInvoiceService } from './auto-invoice.service.js';
import { CreditLimitService } from './credit-limit.service.js';
import { CreditNotesService } from './credit-notes.service.js';
import { CustomerStatementService } from './customer-statement.service.js';
import { BillingReportsService } from './billing-reports.service.js';
import { InvoiceDraftsController } from './invoice-drafts.controller.js';
import { InvoiceDraftsService } from './invoice-drafts.service.js';
import { InvoicesService } from './invoices.service.js';
import { ReceiptDraftsController } from './receipt-drafts.controller.js';
import { ReceiptDraftsService } from './receipt-drafts.service.js';
import { ReceiptApplicationsService } from './receipt-applications.service.js';
import { ReceiptsService } from './receipts.service.js';

@Module({
  imports: [
    AccountingModule,
    BookingsModule,
    CurrenciesModule,
    CustomersModule,
    DraftsModule,
    MasterDataModule,
    QuotationsModule,
    RatesModule,
    ShipmentsModule,
  ],
  controllers: [
    InvoicesController,
    ReceiptsController,
    CreditNotesController,
    CustomerStatementsController,
    CustomerCreditController,
    InvoiceDraftsController,
    ReceiptDraftsController,
  ],
  providers: [
    InvoicesService,
    AutoInvoiceService,
    ReceiptsService,
    ReceiptApplicationsService,
    CreditNotesService,
    CreditLimitService,
    BillingReportsService,
    CustomerStatementService,
    InvoiceDraftsService,
    ReceiptDraftsService,
  ],
  exports: [
    BillingReportsService,
    CreditLimitService,
    InvoiceDraftsService,
    InvoicesService,
    ReceiptDraftsService,
  ],
})
export class BillingModule {}
