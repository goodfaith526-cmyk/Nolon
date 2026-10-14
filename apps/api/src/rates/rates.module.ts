import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { ImportsModule } from '../imports/imports.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { RateCardDraftsController } from './rate-card-drafts.controller.js';
import { RateCardDraftsService } from './rate-card-drafts.service.js';
import { RatesImportController } from './rates-import.controller.js';
import { RatesImportService } from './rates-import.service.js';
import { RatesController } from './rates.controller.js';
import { RatesService } from './rates.service.js';

@Module({
  imports: [AuditModule, MasterDataModule, CurrenciesModule, ImportsModule, DraftsModule],
  controllers: [RatesImportController, RatesController, RateCardDraftsController],
  providers: [RatesService, RatesImportService, RateCardDraftsService],
  exports: [RatesService, RateCardDraftsService],
})
export class RatesModule {}
