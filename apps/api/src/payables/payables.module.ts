import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { ConsolidationsModule } from '../consolidations/consolidations.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import {
  SupplierBillsController,
  SupplierPaymentsController,
  SuppliersController,
} from './payables.controller.js';
import { ContainerCostsService } from './container-costs.service.js';
import { PayablesReportsService } from './payables-reports.service.js';
import { SupplierBillsService } from './supplier-bills.service.js';
import { SupplierPaymentsService } from './supplier-payments.service.js';
import { SuppliersService } from './suppliers.service.js';

/** Payables (scope 13): suppliers, supplier bills and supplier payments, and AP aging. */
@Module({
  imports: [
    AccountingModule,
    ConsolidationsModule,
    CurrenciesModule,
    MasterDataModule,
    ShipmentsModule,
    TransportModule,
  ],
  controllers: [SuppliersController, SupplierBillsController, SupplierPaymentsController],
  providers: [
    SuppliersService,
    SupplierBillsService,
    ContainerCostsService,
    SupplierPaymentsService,
    PayablesReportsService,
  ],
  exports: [PayablesReportsService, SuppliersService],
})
export class PayablesModule {}
