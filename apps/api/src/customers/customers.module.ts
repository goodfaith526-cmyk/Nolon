import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { ImportsModule } from '../imports/imports.module.js';
import { CustomerDraftsController } from './customer-drafts.controller.js';
import { CustomerDraftsService } from './customer-drafts.service.js';
import { CustomersImportController } from './customers-import.controller.js';
import { CustomersImportService } from './customers-import.service.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [AuditModule, CurrenciesModule, ImportsModule, DraftsModule],
  controllers: [CustomersImportController, CustomersController, CustomerDraftsController],
  providers: [CustomersService, CustomersImportService, CustomerDraftsService],
  exports: [CustomersService],
})
export class CustomersModule {}
