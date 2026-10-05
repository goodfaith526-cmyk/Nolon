import { Module } from '@nestjs/common';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { RatesImportController } from './rates-import.controller.js';
import { RatesImportService } from './rates-import.service.js';
import { RatesController } from './rates.controller.js';
import { RatesService } from './rates.service.js';

@Module({
  imports: [MasterDataModule, CurrenciesModule],
  controllers: [RatesImportController, RatesController],
  providers: [RatesService, RatesImportService],
  exports: [RatesService],
})
export class RatesModule {}
