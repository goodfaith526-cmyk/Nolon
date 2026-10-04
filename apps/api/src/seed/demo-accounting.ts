import type { BranchCode, CurrencyCode } from '@nolon/shared';
import { toDbDate } from '../common/dates.js';
import { dec } from '../common/money.js';
import type { PrismaClient } from '../generated/prisma/client.js';

/** Marks the demo set as loaded, so later deploys never add it twice. */
const DEMO_MARKER = 'demo.accounting.v1';

/** Every demo record carries this label, so nobody mistakes it for a real account or rate. */
const DEMO = '(تجريبي)';

interface DemoCashAccount {
  code: string;
  branch: BranchCode;
  currency: CurrencyCode;
  nameEn: string;
  nameAr: string;
}

/** Cash and bank accounts under 1100, one currency each, so receipts can be recorded. */
const CASH_ACCOUNTS: readonly DemoCashAccount[] = [
  { code: '1110', branch: 'DXB', currency: 'AED', nameEn: 'Dubai cash', nameAr: 'نقدية دبي' },
  {
    code: '1111',
    branch: 'DXB',
    currency: 'USD',
    nameEn: 'Dubai bank USD',
    nameAr: 'بنك دبي دولار',
  },
  { code: '1120', branch: 'JED', currency: 'SAR', nameEn: 'Jeddah cash', nameAr: 'نقدية جدة' },
  {
    code: '1130',
    branch: 'PTS',
    currency: 'SDG',
    nameEn: 'Port Sudan cash',
    nameAr: 'نقدية بورتسودان',
  },
  {
    code: '1131',
    branch: 'PTS',
    currency: 'USD',
    nameEn: 'Port Sudan cash USD',
    nameAr: 'نقدية بورتسودان دولار',
  },
  { code: '1140', branch: 'ATB', currency: 'SDG', nameEn: 'Atbara cash', nameAr: 'نقدية عطبرة' },
  {
    code: '1150',
    branch: 'KRT',
    currency: 'SDG',
    nameEn: 'Khartoum cash',
    nameAr: 'نقدية الخرطوم',
  },
];

/** Units per 1 USD. Illustrative values for trying the screens, not market rates. */
const RATES: readonly { currency: CurrencyCode; rate: string }[] = [
  { currency: 'AED', rate: '3.6725' },
  { currency: 'SAR', rate: '3.75' },
  { currency: 'EUR', rate: '0.86' },
  { currency: 'SDG', rate: '600' },
];

/**
 * Staging demo for billing: branch cash accounts and exchange rates dated the first of the year
 * and today, so invoices and receipts can be tried right away. Loaded once (DEMO_MARKER). Needs
 * an Administrator to own the rates; without one it does nothing and tries again next deploy.
 */
export async function seedDemoAccounting(prisma: PrismaClient): Promise<void> {
  if (await prisma.systemSetting.findUnique({ where: { key: DEMO_MARKER } })) {
    console.log('Demo accounting data already loaded; skipped.');
    return;
  }
  const admin = await prisma.user.findFirst({
    where: { isActive: true, roles: { some: { role: 'ADMINISTRATOR' } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) {
    console.log('Demo accounting data skipped: no Administrator to own the exchange rates.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const parent = await tx.account.findUniqueOrThrow({ where: { code: '1100' } });
    const branches = await tx.branch.findMany();
    for (const a of CASH_ACCOUNTS) {
      const branch = branches.find((b) => b.code === a.branch);
      if (!branch) continue;
      await tx.account.upsert({
        where: { code: a.code },
        update: {},
        create: {
          code: a.code,
          nameEn: `${a.nameEn} (demo)`,
          nameAr: `${a.nameAr} ${DEMO}`,
          type: 'ASSET',
          parentId: parent.id,
          isPostable: true,
          isCash: true,
          currency: a.currency,
          branchId: branch.id,
        },
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const dates = [...new Set([`${today.slice(0, 4)}-01-01`, today])];
    for (const rateDate of dates) {
      for (const r of RATES) {
        const key = { currency: r.currency, rateDate: toDbDate(rateDate) };
        await tx.fxRate.upsert({
          where: { currency_rateDate: key },
          update: {},
          create: { ...key, rate: dec(r.rate), createdById: admin.id },
        });
      }
    }

    await tx.systemSetting.create({
      data: { key: DEMO_MARKER, value: { loadedAt: new Date().toISOString() } },
    });
  });
  console.log('Demo accounting data loaded.');
}
