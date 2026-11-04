import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WarehousesService } from '../warehouse/warehouses.service.js';
import { softLaunchActor } from './soft-launch.js';
import { applyTrialDropOff, applyTrialFacilities } from './trial-facilities.js';

/**
 * Enters the trial facilities (trial-facilities.ts) into this database, through NOLON's services.
 * Run inside the api container:
 *   docker compose -f docker-compose.staging.yml exec -T api node dist/seed/trial-facilities-main.js
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
    const warehouses = app.get(WarehousesService);
    const report = await applyTrialFacilities(
      { prisma, masterData: app.get(MasterDataService), warehouses },
      actor,
    );
    // Plan 09 section 11: the origin facilities receive cargo from customers.
    report.push(...(await applyTrialDropOff({ prisma, warehouses }, actor)));
    console.log(`As ${actor.fullName}:`);
    for (const line of report) console.log(`- ${line}`);
  } finally {
    await app.close();
  }
}

await main();
