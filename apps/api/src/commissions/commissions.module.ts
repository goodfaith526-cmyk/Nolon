import { ReferrerChannelsModule } from '../partners/referrer-channels.module.js';
import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CurrenciesModule } from '../currencies/currencies.module.js';
import { PartnerContractsModule } from '../partners/partner-contracts.module.js';
import { PayablesModule } from '../payables/payables.module.js';
import { ShipmentsModule } from '../shipments/shipments.module.js';
import { TransportModule } from '../transport/transport.module.js';
import { CommissionAccrualService } from './commission-accrual.service.js';
import { CommissionsDueService } from './commissions-due.service.js';
import { CommissionsController } from './commissions.controller.js';
import { PartnerStatementsService } from './partner-statements.service.js';

/**
 * Partner commissions (plan 07). It reads shipments, invoices and proofs of delivery and makes
 * supplier bills, so it sits above them; they reach it through CommissionTriggers and
 * StatementBills, which it registers with.
 */
@Module({
  imports: [
    AccountingModule,
    AuditModule,
    BillingModule,
    CurrenciesModule,
    PartnerContractsModule,
    PayablesModule,
    ReferrerChannelsModule,
    ShipmentsModule,
    TransportModule,
  ],
  controllers: [CommissionsController],
  providers: [CommissionAccrualService, CommissionsDueService, PartnerStatementsService],
  exports: [CommissionAccrualService],
})
export class CommissionsModule {}
