import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';
import { WindowCashAccountsController } from './window-cash-accounts.controller.js';
import { WindowCashAccountsService } from './window-cash-accounts.service.js';
import { WindowCollectService } from './window-collect.service.js';
import { WindowDeskController } from './window-desk.controller.js';
import { WindowDeskService } from './window-desk.service.js';

/** Plan 13 sections 2 and 2a: the window desk, the only entry point for a window's work. */
@Module({
  imports: [
    AccountingModule,
    AuditModule,
    BillingModule,
    CurrenciesModule,
    ShipmentsModule,
    WarehouseModule,
  ],
  controllers: [WindowDeskController, WindowCashAccountsController],
  providers: [WindowDeskService, WindowCollectService, WindowCashAccountsService],
  // The staging test autocycle receives and collects through them (test-autocycle).
  exports: [WindowDeskService, WindowCollectService],
})
export class WindowDeskModule {}
