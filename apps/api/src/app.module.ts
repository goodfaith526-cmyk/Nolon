import { Module } from '@nestjs/common';
import { AccountingModule } from './accounting/accounting.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { BookingsModule } from './bookings/bookings.module.js';
import { ConfigModule } from './config/config.module.js';
import { CurrenciesModule } from './currencies/currencies.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { CustomsModule } from './customs/customs.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { ExpensesModule } from './expenses/expenses.module.js';
import { HealthModule } from './health/health.module.js';
import { MasterDataModule } from './master-data/master-data.module.js';
import { PayablesModule } from './payables/payables.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { QuotationsModule } from './quotations/quotations.module.js';
import { RatesModule } from './rates/rates.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ShipmentsModule } from './shipments/shipments.module.js';
import { TransportModule } from './transport/transport.module.js';
import { UsersModule } from './users/users.module.js';
import { WarehouseModule } from './warehouse/warehouse.module.js';

// Business modules (customers, bookings, shipments, finance...) are added here, one per folder.
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    HealthModule,
    CurrenciesModule,
    MasterDataModule,
    CustomersModule,
    RatesModule,
    QuotationsModule,
    BookingsModule,
    DashboardModule,
    ShipmentsModule,
    DocumentsModule,
    AccountingModule,
    BillingModule,
    WarehouseModule,
    CustomsModule,
    TransportModule,
    PayablesModule,
    ExpensesModule,
    ReportsModule,
  ],
})
export class AppModule {}
