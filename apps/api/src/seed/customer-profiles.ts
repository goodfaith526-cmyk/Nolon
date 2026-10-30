import 'dotenv/config';
import { loadEnv } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { backfillCustomerProfiles } from './customer-profile-backfill.js';

// A manual, owner-reviewed rollout operation. Default is counts only; no PII or credentials printed.
const env = loadEnv();
if (!env.CS_CUSTOMER_IDENTITY_COMPANY_ID)
  throw new Error('Set the deployment company namespace first');
const prisma = new PrismaService(env);
try {
  console.log(
    JSON.stringify(
      await backfillCustomerProfiles(
        prisma,
        env.CS_CUSTOMER_IDENTITY_COMPANY_ID,
        process.argv.includes('--apply'),
      ),
    ),
  );
} finally {
  await prisma.$disconnect();
}
