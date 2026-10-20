import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesService } from './currencies.service.js';

@Module({
  imports: [AuditModule],
  providers: [CurrenciesService],
  exports: [CurrenciesService],
})
export class CurrenciesModule {}
