import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { todayIn } from '../common/dates.js';
import { ApiClientsService } from '../customer-service/api-clients.service.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RatesService } from '../rates/rates.service.js';
import { softLaunchActor } from './soft-launch.js';
import { applyTrialPrices } from './trial-prices.js';

/**
 * Enters the trial prices (trial-prices.ts) into this database, through NOLON's services. Run
 * inside the api container, after the soft-launch script:
 *   docker compose -f docker-compose.staging.yml exec -T api node dist/seed/trial-prices-main.js
 * Optional: SOFT_LAUNCH_ACTOR_EMAIL (the Administrator it acts as; default the first one). Safe to
 * repeat.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const actor = await softLaunchActor(prisma, process.env.SOFT_LAUNCH_ACTOR_EMAIL || undefined);
    const report = await applyTrialPrices(
      {
        prisma,
        masterData: app.get(MasterDataService),
        rates: app.get(RatesService),
        apiClients: app.get(ApiClientsService),
      },
      actor,
      { today: todayIn('UTC') },
    );
    console.log(`As ${actor.fullName}:`);
    for (const line of report) console.log(`- ${line}`);
  } finally {
    await app.close();
  }
}

await main();
