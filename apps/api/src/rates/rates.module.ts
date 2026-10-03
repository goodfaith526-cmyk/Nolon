import { Module } from '@nestjs/common';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { RatesController } from './rates.controller.js';
import { RatesService } from './rates.service.js';

@Module({
  imports: [MasterDataModule, CurrenciesModule],
  controllers: [RatesController],
  providers: [RatesService],
  exports: [RatesService],
})
export class RatesModule {}
