import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { PayablesModule } from '../payables/payables.module.js';
import { PartnersController } from './partners.controller.js';
import { PartnersService } from './partners.service.js';

/** Partners of the network: sales outlets, consolidators, overseas agents, distributors. */
@Module({
  imports: [AuditModule, CurrenciesModule, MasterDataModule, PayablesModule],
  controllers: [PartnersController],
  providers: [PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
