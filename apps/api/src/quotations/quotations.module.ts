import { Module } from '@nestjs/common';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { PartnerRefsModule } from '../partners/partner-refs.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { NewCustomerQuotationDraftsController } from './new-customer-quotation-drafts.controller.js';
import { NewCustomerQuotationDraftsService } from './new-customer-quotation-drafts.service.js';
import { QuotationDraftsController } from './quotation-drafts.controller.js';
import { QuotationDraftsService } from './quotation-drafts.service.js';
import { QuotationsController } from './quotations.controller.js';
import { QuotationsService } from './quotations.service.js';
import { QuotationReportsService } from './quotation-reports.service.js';

@Module({
  imports: [
    CustomersModule,
    RatesModule,
    MasterDataModule,
    CurrenciesModule,
    DraftsModule,
    PartnerRefsModule,
  ],
  controllers: [
    QuotationsController,
    QuotationDraftsController,
    NewCustomerQuotationDraftsController,
  ],
  providers: [
    QuotationReportsService,
    QuotationsService,
    QuotationDraftsService,
    NewCustomerQuotationDraftsService,
  ],
  exports: [
    QuotationReportsService,
    QuotationsService,
    QuotationDraftsService,
    NewCustomerQuotationDraftsService,
  ],
})
export class QuotationsModule {}
