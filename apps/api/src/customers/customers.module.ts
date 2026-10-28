import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { DraftsModule } from '../drafts/drafts.module.js';
import { ImportsModule } from '../imports/imports.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { PartnerRefsModule } from '../partners/partner-refs.module.js';
import { CustomerDraftsController } from './customer-drafts.controller.js';
import { CustomerDraftsService } from './customer-drafts.service.js';
import { CustomersImportController } from './customers-import.controller.js';
import { CustomersImportService } from './customers-import.service.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';
import { PartyDraftsController } from './party-drafts.controller.js';
import { PartyDraftsService } from './party-drafts.service.js';

@Module({
  imports: [
    AuditModule,
    CurrenciesModule,
    ImportsModule,
    DraftsModule,
    MasterDataModule,
    PartnerRefsModule,
  ],
  controllers: [
    CustomersImportController,
    CustomersController,
    CustomerDraftsController,
    PartyDraftsController,
  ],
  providers: [CustomersService, CustomersImportService, CustomerDraftsService, PartyDraftsService],
  exports: [CustomersService, CustomerDraftsService, PartyDraftsService],
})
export class CustomersModule {}
