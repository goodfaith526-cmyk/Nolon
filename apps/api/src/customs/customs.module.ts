import { Module } from '@nestjs/common';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { CustomsController } from './customs.controller.js';
import { CustomsService } from './customs.service.js';

@Module({
  imports: [ShipmentsModule, CurrenciesModule],
  controllers: [CustomsController],
  providers: [CustomsService],
})
export class CustomsModule {}
