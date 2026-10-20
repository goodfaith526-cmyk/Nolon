import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { MasterDataController } from './master-data.controller.js';
import { MasterDataService } from './master-data.service.js';

@Module({
  imports: [AuditModule, CurrenciesModule],
  controllers: [MasterDataController],
  providers: [MasterDataService],
  exports: [MasterDataService],
})
export class MasterDataModule {}
