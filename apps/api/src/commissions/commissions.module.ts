import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { PartnerContractsModule } from '../partners/partner-contracts.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { CommissionAccrualService } from './commission-accrual.service.js';
import { CommissionsController } from './commissions.controller.js';

/**
 * Partner commissions (plan 07). It reads shipments, invoices and proofs of delivery, so it sits
 * above them; they reach its sync through CommissionTriggers, which it registers with.
 */
@Module({
  imports: [
    AccountingModule,
    AuditModule,
    BillingModule,
    CurrenciesModule,
    PartnerContractsModule,
    ShipmentsModule,
    TransportModule,
  ],
  controllers: [CommissionsController],
  providers: [CommissionAccrualService],
  exports: [CommissionAccrualService],
})
export class CommissionsModule {}
