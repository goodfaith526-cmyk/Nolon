import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { ImportsModule } from '../imports/imports.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { PartnerContractsModule } from '../partners/partner-contracts.module.js';
import { RateCostsController } from './rate-costs.controller.js';
import { RateCostsService } from './rate-costs.service.js';
import { RateCardDraftsController } from './rate-card-drafts.controller.js';
import { RateCardDraftsService } from './rate-card-drafts.service.js';
import { RatesImportController } from './rates-import.controller.js';
import { RatesImportService } from './rates-import.service.js';
import { RatesController } from './rates.controller.js';
import { RatesService } from './rates.service.js';

@Module({
  imports: [
    AuditModule,
    MasterDataModule,
    CurrenciesModule,
    ImportsModule,
    DraftsModule,
    AccountingModule,
    PartnerContractsModule,
  ],
  controllers: [
    RatesImportController,
    RatesController,
    RateCostsController,
    RateCardDraftsController,
  ],
  providers: [RatesService, RatesImportService, RateCardDraftsService, RateCostsService],
  exports: [RatesService, RateCardDraftsService, RateCostsService],
})
export class RatesModule {}
