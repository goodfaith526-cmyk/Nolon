import { Module } from '@nestjs/common';
import { CurrenciesService } from './currencies.service.js';

@Module({
  providers: [CurrenciesService],
  exports: [CurrenciesService],
})
export class CurrenciesModule {}
