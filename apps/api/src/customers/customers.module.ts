import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { ImportsModule } from '../imports/imports.module.js';
import { CustomersImportController } from './customers-import.controller.js';
import { CustomersImportService } from './customers-import.service.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [AuditModule, CurrenciesModule, ImportsModule],
  controllers: [CustomersImportController, CustomersController],
  providers: [CustomersService, CustomersImportService],
  exports: [CustomersService],
})
export class CustomersModule {}
