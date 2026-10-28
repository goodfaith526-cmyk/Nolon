import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { RatesModule } from '../rates/rates.module.js';
import { CatalogService } from './catalog.service.js';
import { ApiClientGuard } from './api-client.guard.js';
import { ApiClientsService } from './api-clients.service.js';
import { CustomerMeService } from './customer-me.service.js';
import {
  ApiClientsController,
  CatalogController,
  CustomerMeController,
  CustomerServiceController,
  CustomerTokensController,
} from './customer-service.controller.js';
import { CustomerServiceService } from './customer-service.service.js';
import { CustomerTokenGuard } from './customer-token.guard.js';
import { CustomerTokensService } from './customer-tokens.service.js';

/** The Customer Service API and its keys (scope section 17). */
@Module({
  imports: [AuditModule, MasterDataModule, RatesModule],
  controllers: [
    CustomerServiceController,
    CustomerTokensController,
    CatalogController,
    CustomerMeController,
    ApiClientsController,
  ],
  providers: [
    ApiClientGuard,
    ApiClientsService,
    CustomerServiceService,
    CustomerTokensService,
    CustomerTokenGuard,
    CustomerMeService,
    CatalogService,
  ],
})
export class CustomerServiceModule {}
