import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { CurrenciesModule } from './currencies/currencies.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

// Business modules (customers, bookings, shipments, finance...) are added here, one per folder.
@Module({
  imports: [ConfigModule, PrismaModule, HealthModule, CurrenciesModule],
})
export class AppModule {}
