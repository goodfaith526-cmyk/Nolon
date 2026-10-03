import { Module } from '@nestjs/common';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { QuotationsController } from './quotations.controller.js';
import { QuotationsService } from './quotations.service.js';

@Module({
  imports: [CustomersModule, RatesModule, MasterDataModule, CurrenciesModule],
  controllers: [QuotationsController],
  providers: [QuotationsService],
  exports: [QuotationsService],
})
export class QuotationsModule {}
