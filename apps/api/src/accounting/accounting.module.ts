import { Module } from '@nestjs/common';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { AccountingController } from './accounting.controller.js';
import { AccountsService } from './accounts.service.js';
import { AutoJournalService } from './auto-journal.service.js';
import { FxRatesService } from './fx-rates.service.js';
import { JournalService } from './journal.service.js';
import { ManualJournalsService } from './manual-journals.service.js';
import { PeriodsService } from './periods.service.js';
import { TrialBalanceService } from './trial-balance.service.js';

@Module({
  imports: [CurrenciesModule, MasterDataModule],
  controllers: [AccountingController],
  providers: [
    AccountsService,
    FxRatesService,
    PeriodsService,
    JournalService,
    ManualJournalsService,
    AutoJournalService,
    TrialBalanceService,
  ],
  exports: [AccountsService, FxRatesService, PeriodsService, AutoJournalService],
})
export class AccountingModule {}
