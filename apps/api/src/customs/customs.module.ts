import { Module } from '@nestjs/common';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { PayablesModule } from '../payables/payables.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { CustomsController } from './customs.controller.js';
import { CustomsService } from './customs.service.js';
import { CustomsReportsService } from './customs-reports.service.js';

@Module({
  imports: [ShipmentsModule, CurrenciesModule, PayablesModule],
  controllers: [CustomsController],
  providers: [CustomsReportsService, CustomsService],
  exports: [CustomsReportsService],
})
export class CustomsModule {}
