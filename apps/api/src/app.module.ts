import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import { CurrenciesModule } from './currencies/currencies.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { UsersModule } from './users/users.module.js';

// Business modules (customers, bookings, shipments, finance...) are added here, one per folder.
@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, UsersModule, HealthModule, CurrenciesModule],
})
export class AppModule {}
