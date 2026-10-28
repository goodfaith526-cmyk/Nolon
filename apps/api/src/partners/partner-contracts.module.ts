import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { PartnerContractsController } from './partner-contracts.controller.js';
import { PartnerContractsService } from './partner-contracts.service.js';

/**
 * Partners' commission contracts (business model plan 3.4). Its own module, apart from
 * PartnersModule (which reaches payables and shipments), so the rates can read a commission.
 */
@Module({
  imports: [AuditModule, CurrenciesModule, MasterDataModule],
  controllers: [PartnerContractsController],
  providers: [PartnerContractsService],
  exports: [PartnerContractsService],
})
export class PartnerContractsModule {}
