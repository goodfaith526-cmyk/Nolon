import { randomUUID } from 'node:crypto';
import type { Page } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbDate } from '../src/common/dates.js';
import {
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { uniquePhone } from './test-data.js';

/**
 * Generic list filters for staff and the staff assistant: branch, period, status lists, overdue,
 * payment status, fleet and validity, and strict queries (an unknown filter is a 400, never
 * unfiltered rows). Rows are written straight to the database (no journals are posted), dated far
 * from other suites' data and removed afterwards; every assertion is narrowed to this run's rows.
 */
describe('list filters', () => {
  let t: TestApp;
  let dxb: string;
  let jed: string;
  let managerDxb = '';
  let managerBoth = '';
  const tag = `ZZLF${randomUUID().slice(0, 6).toUpperCase()}`;
  const ids: Record<string, string> = {};
  let period: { id: string; created: boolean };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  /** The ids a list returns (asserting 200). */
  async function listIds(path: string, cookie: string): Promise<string[]> {
    const page = (await get(path, cookie).expect(200)).body as Page<{ id: string }>;
    return page.items.map((i) => i.id).sort();
  }
  const sorted = (...keys: string[]) => keys.map((k) => ids[k]).sort();
  const day = toDbDate;
  let n = 0;
  const num = () => `${tag}-${++n}`;

  beforeAll(async () => {
    t = await createTestApp();
    const prisma = t.prisma;
    dxb = await branchId(prisma, 'DXB');
    jed = await branchId(prisma, 'JED');
    const author = await createUser(prisma, ['ADMINISTRATOR']);
    const dxbUser = await createUser(prisma, ['BRANCH_MANAGER'], ['DXB']);
    const bothUser = await createUser(prisma, ['BRANCH_MANAGER', 'FINANCE'], ['DXB', 'JED']);
    managerDxb = await signIn(t, dxbUser.email);
    managerBoth = await signIn(t, bothUser.email);
    const createdById = author.id;
    const loc = async (code: string) =>
      (await prisma.location.findUniqueOrThrow({ where: { code } })).id;
    const jebelAli = await loc('AEJEA');
    const portSudan = await loc('SDPZU');
    const route = { originLocationId: jebelAli, destinationLocationId: portSudan };
    const usd = { currency: 'USD', fxRate: '1' };

    // Master rows.
    const customer = async (
      key: string,
      branch: string,
      fields: { kind: 'COMPANY' | 'INDIVIDUAL'; isActive: boolean },
    ) => {
      ids[key] = (
        await prisma.customer.create({
          data: {
            number: num(),
            branchId: branch,
            name: `${tag} ${key}`,
            phone: uniquePhone(),
            createdById,
            ...fields,
          },
        })
      ).id;
    };
    await customer('custDxbCompany', dxb, { kind: 'COMPANY', isActive: true });
    await customer('custDxbInactive', dxb, { kind: 'INDIVIDUAL', isActive: false });
    await customer('custJed', jed, { kind: 'COMPANY', isActive: true });
    const customerId = ids.custDxbCompany as string;
    ids.supplier = (
      await prisma.supplier.create({
        data: { number: num(), name: `${tag} supplier`, createdById },
      })
    ).id;
    const supplierId = ids.supplier;
    ids.cash = (
      await prisma.account.create({
        data: {
          code: tag,
          nameEn: 'List filters cash',
          nameAr: 'نقدية',
          type: 'ASSET',
          isCash: true,
          currency: 'USD',
        },
      })
    ).id;
    const cashAccountId = ids.cash;
    const existing = await prisma.fiscalPeriod.findFirst();
    period = existing
      ? { id: existing.id, created: false }
      : {
          id: (
            await prisma.fiscalPeriod.create({
              data: {
                year: 2093,
                month: 1,
                startDate: day('2093-01-01'),
                endDate: day('2093-01-31'),
              },
            })
          ).id,
          created: true,
        };
    /**
     * A draft journal entry for a row that needs one (drafts can be deleted). The rows are not
     * posted: only the list filters are under test.
     */
    const draftEntry = async (
      branch: string,
      source: 'RECEIPT' | 'SUPPLIER_PAYMENT' | 'CUSTOMER_INVOICE' | 'SUPPLIER_BILL',
    ) =>
      (
        await prisma.journalEntry.create({
          data: {
            number: num(),
            branchId: branch,
            entryDate: day('2093-01-01'),
            periodId: period.id,
            description: tag,
            source,
            createdById,
          },
        })
      ).id;

    // Quotations and bookings: created 20:30 UTC, already the next day in Dubai (UTC+4), not yet
    // in Jeddah (UTC+3).
    const quotation = async (key: string, branch: string, createdAt: string) => {
      ids[key] = (
        await prisma.quotation.create({
          data: {
            number: num(),
            branchId: branch,
            customerId,
            ...route,
            mode: 'SEA',
            cargoType: 'CONTAINER',
            currency: 'USD',
            validUntil: day('2093-12-31'),
            createdById,
            createdAt: new Date(createdAt),
          },
        })
      ).id;
    };
    await quotation('quoteMar10', dxb, '2093-03-09T20:30:00Z');
    await quotation('quoteMar11', dxb, '2093-03-10T20:30:00Z');
    await quotation('quoteJed', jed, '2093-03-09T20:30:00Z');
    const booking = async (key: string, branch: string, createdAt: string) => {
      ids[key] = (
        await prisma.booking.create({
          data: {
            number: num(),
            branchId: branch,
            customerId,
            ...route,
            mode: 'SEA',
            cargoType: 'CONTAINER',
            services: ['MAIN_FREIGHT'],
            createdById,
            createdAt: new Date(createdAt),
          },
        })
      ).id;
    };
    await booking('bookMar10', dxb, '2093-03-09T20:30:00Z');
    await booking('bookMar11', dxb, '2093-03-10T20:30:00Z');
    await booking('bookJed', jed, '2093-03-09T20:30:00Z');
    await booking('bookForShipJed', jed, '2093-03-09T20:30:00Z');

    // Shipments (each on its own booking).
    const shipment = async (
      key: string,
      bookingKey: string,
      branch: string,
      fields: {
        mode: 'SEA' | 'ROAD';
        status: 'CREATED' | 'IN_TRANSIT' | 'CLOSED';
        closedAt?: Date;
      },
      createdAt: string,
      eta: string,
    ) => {
      ids[key] = (
        await prisma.shipment.create({
          data: {
            number: num(),
            branchId: branch,
            customerId,
            bookingId: ids[bookingKey] as string,
            ...route,
            cargoType: 'CONTAINER',
            services: ['MAIN_FREIGHT'],
            trackingToken: randomUUID().replace(/-/g, ''),
            createdById,
            createdAt: new Date(createdAt),
            eta: day(eta),
            ...fields,
          },
        })
      ).id;
    };
    await shipment(
      'shipSea',
      'bookMar10',
      dxb,
      { mode: 'SEA', status: 'CREATED' },
      '2093-03-09T20:30:00Z',
      '2093-04-01',
    );
    await shipment(
      'shipRoad',
      'bookMar11',
      dxb,
      { mode: 'ROAD', status: 'IN_TRANSIT' },
      '2093-03-10T20:30:00Z',
      '2093-05-01',
    );
    await shipment(
      'shipClosed',
      'bookJed',
      jed,
      { mode: 'SEA', status: 'CLOSED', closedAt: new Date('2093-06-02T00:00:00Z') },
      '2093-03-09T20:30:00Z',
      '2093-06-01',
    );
    // A JED shipment shared with DXB: visible in DXB.
    await shipment(
      'shipJedShared',
      'bookForShipJed',
      jed,
      { mode: 'SEA', status: 'CREATED' },
      '2093-03-09T20:30:00Z',
      '2093-06-01',
    );
    await prisma.shipmentBranch.create({
      data: { shipmentId: ids.shipJedShared as string, branchId: dxb },
    });

    // Consolidations by ETD.
    const consolidation = async (key: string, branch: string, etd: string) => {
      ids[key] = (
        await prisma.consolidation.create({
          data: {
            number: num(),
            branchId: branch,
            ...route,
            containerTypeCode: '40HC',
            etd: day(etd),
            createdById,
          },
        })
      ).id;
    };
    await consolidation('consJan', dxb, '2093-01-10');
    await consolidation('consFeb', dxb, '2093-02-10');
    await consolidation('consJed', jed, '2093-01-10');

    // Fleet and trips by planned departure.
    ids.vehicle = (
      await prisma.vehicle.create({
        data: { branchId: dxb, plateNumber: `ZZ${tag}`, vehicleType: 'Truck' },
      })
    ).id;
    ids.driver = (await prisma.driver.create({ data: { branchId: dxb, name: `ZZ ${tag}` } })).id;
    ids.carrier = (await prisma.carrier.create({ data: { name: `ZZ ${tag}` } })).id;
    const trip = async (
      key: string,
      branch: string,
      plannedDeparture: string,
      fleet: { vehicleId?: string; driverId?: string; carrierId?: string },
    ) => {
      ids[key] = (
        await prisma.trip.create({
          data: {
            number: num(),
            branchId: branch,
            kind: fleet.carrierId ? 'EXTERNAL' : 'OWN',
            ...(fleet.carrierId ? { agreedCost: '500', currency: 'USD' } : {}),
            ...route,
            plannedDeparture: new Date(plannedDeparture),
            createdById,
            ...fleet,
          },
        })
      ).id;
    };
    await trip('tripOwn', dxb, '2093-03-09T20:30:00Z', {
      vehicleId: ids.vehicle,
      driverId: ids.driver,
    });
    await trip('tripHired', dxb, '2093-03-10T20:30:00Z', { carrierId: ids.carrier });
    ids.vehicleJed = (
      await prisma.vehicle.create({
        data: { branchId: jed, plateNumber: `ZZ${tag}J`, vehicleType: 'Truck' },
      })
    ).id;
    ids.driverJed = (
      await prisma.driver.create({ data: { branchId: jed, name: `ZZ ${tag} J` } })
    ).id;
    await trip('tripJed', jed, '2093-03-09T20:30:00Z', {
      vehicleId: ids.vehicleJed,
      driverId: ids.driverJed,
    });

    // Customer invoices: dated 2001, overdue unless paid or due in 2099.
    const invoice = async (
      key: string,
      branch: string,
      dates: { invoiceDate: string; dueDate: string },
      money: { paidAmount: string; creditedAmount: string },
      status: 'APPROVED' | 'DRAFT' = 'APPROVED',
    ) => {
      ids[key] = (
        await prisma.customerInvoice.create({
          data: {
            branchId: branch,
            customerId,
            ...usd,
            invoiceDate: day(dates.invoiceDate),
            dueDate: day(dates.dueDate),
            status,
            total: '100',
            totalUsd: '100',
            createdById,
            ...money,
            // An approved row as approval leaves it (an opening item needs no shipment); a draft
            // has no number and belongs to a shipment.
            ...(status === 'APPROVED'
              ? {
                  number: num(),
                  isOpening: true,
                  journalEntryId: await draftEntry(branch, 'CUSTOMER_INVOICE'),
                  receivableAccountId: cashAccountId,
                  approvedAt: new Date(),
                  approvedById: createdById,
                }
              : { shipmentId: ids.shipSea as string }),
          },
        })
      ).id;
    };
    const unpaid = { paidAmount: '0', creditedAmount: '0' };
    await invoice('invOverdue', dxb, { invoiceDate: '2001-01-01', dueDate: '2001-01-31' }, unpaid);
    await invoice(
      'invPartial',
      dxb,
      { invoiceDate: '2001-02-01', dueDate: '2099-12-31' },
      { paidAmount: '40', creditedAmount: '10' },
    );
    await invoice(
      'invPaid',
      dxb,
      { invoiceDate: '2001-03-01', dueDate: '2001-03-31' },
      { paidAmount: '90', creditedAmount: '10' },
    );
    await invoice(
      'invDraft',
      dxb,
      { invoiceDate: '2001-03-15', dueDate: '2001-03-31' },
      unpaid,
      'DRAFT',
    );
    await invoice('invJed', jed, { invoiceDate: '2001-01-15', dueDate: '2001-02-14' }, unpaid);

    // Receipts, credit notes, supplier payments, expenses: by their own date.
    const receipt = async (key: string, branch: string, receiptDate: string) => {
      ids[key] = (
        await prisma.receipt.create({
          data: {
            number: num(),
            branchId: branch,
            customerId,
            receiptDate: day(receiptDate),
            ...usd,
            amount: '10',
            cashAccountId,
            journalEntryId: await draftEntry(branch, 'RECEIPT'),
            createdById,
          },
        })
      ).id;
    };
    await receipt('rcptJan', dxb, '2093-01-10');
    await receipt('rcptFeb', dxb, '2093-02-10');
    await receipt('rcptJed', jed, '2093-01-10');
    const creditNote = async (key: string, branch: string, creditDate: string) => {
      ids[key] = (
        await prisma.creditNote.create({
          data: {
            branchId: branch,
            invoiceId: ids.invPartial as string,
            customerId,
            creditDate: day(creditDate),
            amount: '5',
            reason: tag,
            createdById,
          },
        })
      ).id;
    };
    await creditNote('cnJan', dxb, '2093-01-10');
    await creditNote('cnFeb', dxb, '2093-02-10');
    await creditNote('cnJed', jed, '2093-01-10');

    const bill = async (
      key: string,
      branch: string,
      dates: { billDate: string; dueDate: string },
      paidAmount: string,
    ) => {
      ids[key] = (
        await prisma.supplierBill.create({
          data: {
            number: num(),
            branchId: branch,
            supplierId,
            ...usd,
            billDate: day(dates.billDate),
            dueDate: day(dates.dueDate),
            status: 'APPROVED',
            total: '100',
            totalUsd: '100',
            paidAmount,
            createdById,
            journalEntryId: await draftEntry(branch, 'SUPPLIER_BILL'),
            payableAccountId: cashAccountId,
            approvedAt: new Date(),
            approvedById: createdById,
          },
        })
      ).id;
    };
    await bill('billOverdue', dxb, { billDate: '2001-01-01', dueDate: '2001-01-31' }, '0');
    await bill('billPaid', dxb, { billDate: '2001-02-01', dueDate: '2001-02-28' }, '100');
    await bill('billLater', dxb, { billDate: '2001-03-01', dueDate: '2099-12-31' }, '0');
    await bill('billPartial', dxb, { billDate: '2001-02-15', dueDate: '2099-12-31' }, '30');
    await bill('billJed', jed, { billDate: '2001-01-01', dueDate: '2001-01-31' }, '0');
    const payment = async (key: string, branch: string, paymentDate: string) => {
      ids[key] = (
        await prisma.supplierPayment.create({
          data: {
            number: num(),
            branchId: branch,
            supplierId,
            paymentDate: day(paymentDate),
            ...usd,
            amount: '10',
            cashAccountId,
            journalEntryId: await draftEntry(branch, 'SUPPLIER_PAYMENT'),
            createdById,
          },
        })
      ).id;
    };
    await payment('payJan', dxb, '2093-01-10');
    await payment('payFeb', dxb, '2093-02-10');
    await payment('payJed', jed, '2093-01-10');
    const expense = async (key: string, branch: string, expenseDate: string) => {
      ids[key] = (
        await prisma.expense.create({
          data: {
            branchId: branch,
            expenseDate: day(expenseDate),
            categoryCode: 'GENERAL',
            description: `${tag} expense`,
            amount: '10',
            ...usd,
            cashAccountId,
            createdById,
          },
        })
      ).id;
    };
    await expense('expJan', dxb, '2093-01-10');
    await expense('expFeb', dxb, '2093-02-10');
    await expense('expJed', jed, '2093-01-10');

    // Rates from a test location, by validity.
    ids.location = (
      await prisma.location.create({
        data: {
          code: tag.slice(0, 10),
          kind: 'PORT',
          nameEn: `Port ${tag}`,
          nameAr: 'ميناء',
          countryCode: 'AE',
        },
      })
    ).id;
    const rate = async (key: string, validFrom: string, validTo: string | null) => {
      ids[key] = (
        await prisma.rateCard.create({
          data: {
            branchId: dxb,
            originLocationId: ids.location as string,
            destinationLocationId: portSudan,
            mode: 'SEA',
            cargoType: 'CONTAINER',
            containerTypeCode: '40HC',
            unit: 'PER_CONTAINER',
            price: '1000',
            currency: 'USD',
            validFrom: day(validFrom),
            validTo: validTo === null ? null : day(validTo),
            createdById,
          },
        })
      ).id;
    };
    await rate('rateH1', '2093-01-01', '2093-06-30');
    await rate('rateOpen', '2093-07-01', null);
  });

  afterAll(async () => {
    const prisma = t.prisma;
    const all = Object.values(ids);
    const where = { id: { in: all } };
    await prisma.rateCard.deleteMany({ where });
    await prisma.location.deleteMany({ where });
    await prisma.expense.deleteMany({ where });
    await prisma.supplierPayment.deleteMany({ where });
    await prisma.supplierBill.deleteMany({ where });
    await prisma.creditNote.deleteMany({ where });
    await prisma.receipt.deleteMany({ where });
    await prisma.customerInvoice.deleteMany({ where });
    await prisma.journalEntry.deleteMany({ where: { description: tag, status: 'DRAFT' } });
    await prisma.trip.deleteMany({ where });
    await prisma.vehicle.deleteMany({ where });
    await prisma.driver.deleteMany({ where });
    await prisma.carrier.deleteMany({ where });
    await prisma.consolidation.deleteMany({ where });
    await prisma.shipment.deleteMany({ where });
    await prisma.booking.deleteMany({ where });
    await prisma.quotation.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.supplier.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    if (period.created) await prisma.fiscalPeriod.delete({ where: { id: period.id } });
    await deleteTestUsers(prisma);
    await t.close();
  });

  describe('strict queries', () => {
    it('an unknown filter is a 400 on lists, reports and dashboards, never unfiltered rows', async () => {
      for (const path of [
        '/shipments?branch=DXB',
        '/customers?active=true',
        '/rates?origin=AEJEA',
        '/quotations?dateFrom=2093-01-01',
        '/bookings?bogus=1',
        '/consolidations?bogus=1',
        '/trips?vehicle=x',
        '/customer-invoices?dueBefore=2093-01-01',
        '/receipts?bogus=1',
        '/credit-notes?bogus=1',
        '/supplier-bills?bogus=1',
        '/supplier-payments?bogus=1',
        '/expenses?bogus=1',
        '/suppliers?bogus=1',
        '/accounting/journals?bogus=1',
        '/accounting/fx-rates?bogus=1',
        '/accounting/trial-balance?asOf=2093-01-01&bogus=1',
        '/reports/ar-aging?asOf=2093-01-01&bogus=1',
        '/reports/shipments?from=2093-01-01&to=2093-01-31&bogus=1',
        '/reports/warehouse-on-hand?bogus=1',
        '/dashboard/management?bogus=1',
      ]) {
        const res = await get(path, managerBoth);
        expect(res.status, path).toBe(400);
      }
    });

    it("the web's own parameters are still accepted", async () => {
      for (const path of [
        `/shipments?pageSize=50&status=CREATED&q=`,
        `/customers?pageSize=20&q=${tag}`,
        `/rates?status=APPROVED&originLocationId=${ids.location}&destinationLocationId=${ids.location}&mode=SEA&pageSize=100`,
        `/customer-invoices?customerId=${ids.custDxbCompany}&status=APPROVED&openOnly=true&pageSize=100`,
        `/customer-invoices?shipmentId=${ids.shipSea}&pageSize=50`,
        `/supplier-bills?pageSize=50&q=&status=APPROVED&openOnly=true&supplierId=${ids.supplier}`,
        '/suppliers?activeOnly=true&pageSize=100',
        '/accounting/journals?pageSize=50&q=x&status=DRAFT&source=MANUAL&from=2093-01-01&to=2093-01-31',
      ]) {
        const res = await get(path, managerBoth);
        expect(res.status, path).toBe(200);
      }
    });

    it('an Excel export still takes its locale', async () => {
      await get('/reports/ar-aging/export?asOf=2093-01-01&locale=en', managerBoth).expect(200);
      await get(
        '/reports/shipments/export?from=2093-01-01&to=2093-01-31&locale=ar',
        managerBoth,
      ).expect(200);
      await get('/reports/ar-aging/export?asOf=2093-01-01&locale=en&bogus=1', managerBoth).expect(
        400,
      );
    });
  });

  describe('branch and period on every dated list', () => {
    const dated: { path: string; jan: string; feb: string; jed: string }[] = [
      { path: '/receipts', jan: 'rcptJan', feb: 'rcptFeb', jed: 'rcptJed' },
      { path: '/credit-notes', jan: 'cnJan', feb: 'cnFeb', jed: 'cnJed' },
      { path: '/supplier-payments', jan: 'payJan', feb: 'payFeb', jed: 'payJed' },
      { path: '/expenses', jan: 'expJan', feb: 'expFeb', jed: 'expJed' },
      { path: '/consolidations', jan: 'consJan', feb: 'consFeb', jed: 'consJed' },
    ];

    it('from / to (both included) and branchId narrow the list', async () => {
      for (const d of dated) {
        const base = `${d.path}?pageSize=100`;
        const year = '&from=2093-01-01&to=2093-12-31';
        expect(await listIds(`${base}${year}`, managerBoth), d.path).toEqual(
          sorted(d.jan, d.feb, d.jed),
        );
        expect(await listIds(`${base}&from=2093-01-10&to=2093-01-10`, managerBoth), d.path).toEqual(
          sorted(d.jan, d.jed),
        );
        expect(await listIds(`${base}&from=2093-02-01`, managerBoth), d.path).toEqual(
          sorted(d.feb),
        );
        expect(await listIds(`${base}${year}&branchId=${dxb}`, managerBoth), d.path).toEqual(
          sorted(d.jan, d.feb),
        );
        expect(await listIds(`${base}${year}&branchId=${jed}`, managerBoth), d.path).toEqual(
          sorted(d.jed),
        );
        // Without branchId a DXB user sees DXB only; asking for JED is a 403, not wider access.
        expect(await listIds(`${base}${year}`, managerDxb), d.path).toEqual(sorted(d.jan, d.feb));
        await get(`${base}${year}&branchId=${jed}`, managerDxb).expect(403);
        await get(`${base}&from=2093-02-01&to=2093-01-31`, managerBoth).expect(400);
        await get(`${base}&from=2093-13-01`, managerBoth).expect(400);
        await get(`${base}&branchId=DXB`, managerBoth).expect(400);
      }
    });

    it("quotations and bookings by created day, in the branch's time zone", async () => {
      for (const [path, mar10, mar11, jedKey] of [
        ['/quotations', 'quoteMar10', 'quoteMar11', 'quoteJed'],
        ['/bookings', 'bookMar10', 'bookMar11', 'bookJed'],
      ] as const) {
        const base = `${path}?pageSize=100&customerId=${ids.custDxbCompany}`;
        // Created 20:30 UTC on 9 March: 10 March in Dubai, 9 March in Jeddah (UTC+3).
        expect(await listIds(`${base}&from=2093-03-10&to=2093-03-10`, managerBoth)).toEqual(
          sorted(mar10),
        );
        expect(await listIds(`${base}&from=2093-03-09&to=2093-03-09`, managerBoth)).toEqual(
          path === '/bookings' ? sorted(jedKey, 'bookForShipJed') : sorted(jedKey),
        );
        expect(await listIds(`${base}&from=2093-03-11`, managerBoth)).toEqual(sorted(mar11));
        expect(
          await listIds(`${base}&from=2093-03-01&to=2093-03-31&branchId=${dxb}`, managerBoth),
        ).toEqual(sorted(mar10, mar11));
        await get(`${base}&branchId=${jed}`, managerDxb).expect(403);
        await get(`${base}&from=2093-03-11&to=2093-03-10`, managerBoth).expect(400);
      }
    });
  });

  describe('shipments', () => {
    const base = () => `/shipments?pageSize=100&customerId=${ids.custDxbCompany}`;

    it('status takes one status or a comma list; mode; activeOnly still works', async () => {
      expect(await listIds(`${base()}&status=CREATED`, managerBoth)).toEqual(
        sorted('shipSea', 'shipJedShared'),
      );
      expect(await listIds(`${base()}&status=CREATED,IN_TRANSIT`, managerBoth)).toEqual(
        sorted('shipSea', 'shipRoad', 'shipJedShared'),
      );
      expect(await listIds(`${base()}&mode=ROAD`, managerBoth)).toEqual(sorted('shipRoad'));
      expect(await listIds(`${base()}&activeOnly=true`, managerBoth)).toEqual(
        sorted('shipSea', 'shipRoad', 'shipJedShared'),
      );
      expect(await listIds(`${base()}&status=CLOSED,CREATED&activeOnly=true`, managerBoth)).toEqual(
        sorted('shipSea', 'shipJedShared'),
      );
      await get(`${base()}&status=CREATED,LOST`, managerBoth).expect(400);
      await get(`${base()}&status=`, managerBoth).expect(400);
      await get(`${base()}&mode=AIR`, managerBoth).expect(400);
    });

    it("created from / to in the owning branch's time zone, and ETA from / to", async () => {
      expect(await listIds(`${base()}&from=2093-03-10&to=2093-03-10`, managerBoth)).toEqual(
        sorted('shipSea'),
      );
      expect(await listIds(`${base()}&to=2093-03-09`, managerBoth)).toEqual(
        sorted('shipClosed', 'shipJedShared'),
      );
      expect(await listIds(`${base()}&etaFrom=2093-04-01&etaTo=2093-05-01`, managerBoth)).toEqual(
        sorted('shipSea', 'shipRoad'),
      );
      expect(await listIds(`${base()}&etaFrom=2093-05-02`, managerBoth)).toEqual(
        sorted('shipClosed', 'shipJedShared'),
      );
      await get(`${base()}&etaFrom=2093-05-02&etaTo=2093-05-01`, managerBoth).expect(400);
      await get(`${base()}&from=2093-05-02&to=2093-05-01`, managerBoth).expect(400);
    });

    it('branchId is the branch the shipment is visible in (owner or sharing); never wider', async () => {
      expect(await listIds(`${base()}&branchId=${dxb}`, managerBoth)).toEqual(
        sorted('shipSea', 'shipRoad', 'shipJedShared'),
      );
      expect(await listIds(`${base()}&branchId=${jed}`, managerBoth)).toEqual(
        sorted('shipClosed', 'shipJedShared'),
      );
      expect(await listIds(base(), managerDxb)).toEqual(
        sorted('shipSea', 'shipRoad', 'shipJedShared'),
      );
      await get(`${base()}&branchId=${jed}`, managerDxb).expect(403);
    });
  });

  describe('trips', () => {
    const base = () => `/trips?pageSize=100&q=${tag}`;

    it('vehicle, driver, carrier, planned departure day and branch', async () => {
      expect(await listIds(`${base()}&vehicleId=${ids.vehicle}`, managerBoth)).toEqual(
        sorted('tripOwn'),
      );
      expect(await listIds(`${base()}&driverId=${ids.driver}`, managerBoth)).toEqual(
        sorted('tripOwn'),
      );
      expect(await listIds(`${base()}&carrierId=${ids.carrier}`, managerBoth)).toEqual(
        sorted('tripHired'),
      );
      // Departs 20:30 UTC on 9 March: 10 March in Dubai, 9 March in Jeddah.
      expect(await listIds(`${base()}&from=2093-03-10&to=2093-03-10`, managerBoth)).toEqual(
        sorted('tripOwn'),
      );
      expect(await listIds(`${base()}&to=2093-03-09`, managerBoth)).toEqual(sorted('tripJed'));
      expect(await listIds(`${base()}&branchId=${dxb}`, managerBoth)).toEqual(
        sorted('tripOwn', 'tripHired'),
      );
      expect(await listIds(base(), managerDxb)).toEqual(sorted('tripOwn', 'tripHired'));
      await get(`${base()}&branchId=${jed}`, managerDxb).expect(403);
      await get(`${base()}&vehicleId=not-a-uuid`, managerBoth).expect(400);
      await get(`${base()}&from=2093-03-11&to=2093-03-10`, managerBoth).expect(400);
    });
  });

  describe('customer invoices', () => {
    const base = () => `/customer-invoices?pageSize=100&customerId=${ids.custDxbCompany}`;

    it('overdue: approved, not fully settled, due before today', async () => {
      expect(await listIds(`${base()}&overdue=true`, managerBoth)).toEqual(
        sorted('invOverdue', 'invJed'),
      );
      expect(await listIds(`${base()}&overdue=true&branchId=${dxb}`, managerBoth)).toEqual(
        sorted('invOverdue'),
      );
      expect(await listIds(`${base()}&overdue=true`, managerDxb)).toEqual(sorted('invOverdue'));
      await get(`${base()}&overdue=yes`, managerBoth).expect(400);
    });

    it('paymentStatus as in the summary; invoice date from / to; branch', async () => {
      expect(await listIds(`${base()}&paymentStatus=PARTIAL`, managerBoth)).toEqual(
        sorted('invPartial'),
      );
      expect(await listIds(`${base()}&paymentStatus=PAID`, managerBoth)).toEqual(sorted('invPaid'));
      expect(await listIds(`${base()}&paymentStatus=UNPAID`, managerBoth)).toEqual(
        sorted('invOverdue', 'invDraft', 'invJed'),
      );
      expect(
        await listIds(
          `${base()}&paymentStatus=UNPAID&status=APPROVED&branchId=${dxb}`,
          managerBoth,
        ),
      ).toEqual(sorted('invOverdue'));
      expect(await listIds(`${base()}&from=2001-02-01&to=2001-03-01`, managerBoth)).toEqual(
        sorted('invPartial', 'invPaid'),
      );
      expect(await listIds(`${base()}&openOnly=true`, managerBoth)).toEqual(
        sorted('invOverdue', 'invPartial', 'invJed'),
      );
      await get(`${base()}&paymentStatus=OPEN`, managerBoth).expect(400);
      await get(`${base()}&branchId=${jed}`, managerDxb).expect(403);
      await get(`${base()}&from=2001-03-02&to=2001-03-01`, managerBoth).expect(400);
    });
  });

  describe('supplier bills', () => {
    const base = () => `/supplier-bills?pageSize=100&supplierId=${ids.supplier}`;

    it('overdue, payment status, bill date from / to and branch', async () => {
      expect(await listIds(`${base()}&overdue=true`, managerBoth)).toEqual(
        sorted('billOverdue', 'billJed'),
      );
      expect(await listIds(`${base()}&overdue=true`, managerDxb)).toEqual(sorted('billOverdue'));
      expect(await listIds(`${base()}&from=2001-02-01&to=2001-03-01`, managerBoth)).toEqual(
        sorted('billPaid', 'billPartial', 'billLater'),
      );
      expect(await listIds(`${base()}&paymentStatus=UNPAID`, managerBoth)).toEqual(
        sorted('billOverdue', 'billLater', 'billJed'),
      );
      expect(await listIds(`${base()}&paymentStatus=PARTIAL`, managerBoth)).toEqual(
        sorted('billPartial'),
      );
      expect(await listIds(`${base()}&paymentStatus=PAID&branchId=${dxb}`, managerBoth)).toEqual(
        sorted('billPaid'),
      );
      expect(await listIds(`${base()}&openOnly=true`, managerDxb)).toEqual(
        sorted('billOverdue', 'billPartial', 'billLater'),
      );
      expect(await listIds(`${base()}&branchId=${jed}`, managerBoth)).toEqual(sorted('billJed'));
      await get(`${base()}&branchId=${jed}`, managerDxb).expect(403);
      await get(`${base()}&from=2001-03-02&to=2001-03-01`, managerBoth).expect(400);
      await get(`${base()}&paymentStatus=SETTLED`, managerBoth).expect(400);
    });
  });

  describe('customers', () => {
    const base = `/customers?pageSize=100&q=`;

    it('branchId, kind and isActive', async () => {
      const q = `${base}${tag}`;
      expect(await listIds(q, managerBoth)).toEqual(
        sorted('custDxbCompany', 'custDxbInactive', 'custJed'),
      );
      expect(await listIds(`${q}&branchId=${dxb}`, managerBoth)).toEqual(
        sorted('custDxbCompany', 'custDxbInactive'),
      );
      expect(await listIds(`${q}&kind=COMPANY`, managerBoth)).toEqual(
        sorted('custDxbCompany', 'custJed'),
      );
      expect(await listIds(`${q}&isActive=false`, managerBoth)).toEqual(sorted('custDxbInactive'));
      expect(await listIds(`${q}&isActive=true&kind=COMPANY`, managerDxb)).toEqual(
        sorted('custDxbCompany'),
      );
      await get(`${q}&branchId=${jed}`, managerDxb).expect(403);
      await get(`${q}&kind=PERSON`, managerBoth).expect(400);
      await get(`${q}&isActive=1`, managerBoth).expect(400);
    });
  });

  describe('rates', () => {
    it('q searches the route and codes; validOn picks the rates valid that day; branch', async () => {
      const code = tag.slice(0, 10);
      expect(await listIds(`/rates?pageSize=100&q=${code}`, managerBoth)).toEqual(
        sorted('rateH1', 'rateOpen'),
      );
      expect(
        await listIds(`/rates?pageSize=100&q=port%20${tag.toLowerCase()}`, managerBoth),
      ).toEqual(sorted('rateH1', 'rateOpen'));
      const route = `/rates?pageSize=100&originLocationId=${ids.location}`;
      expect(await listIds(`${route}&q=40HC`, managerBoth)).toEqual(sorted('rateH1', 'rateOpen'));
      expect(await listIds(`${route}&q=20GP`, managerBoth)).toEqual([]);
      expect(await listIds(`${route}&validOn=2093-06-30`, managerBoth)).toEqual(sorted('rateH1'));
      expect(await listIds(`${route}&validOn=2093-07-01`, managerBoth)).toEqual(sorted('rateOpen'));
      expect(await listIds(`${route}&validOn=2199-01-01`, managerBoth)).toEqual(sorted('rateOpen'));
      expect(await listIds(`${route}&validOn=2092-12-31`, managerBoth)).toEqual([]);
      await get(`${route}&validOn=2093-02-30`, managerBoth).expect(400);
      expect(await listIds(`${route}&branchId=${dxb}`, managerBoth)).toEqual(
        sorted('rateH1', 'rateOpen'),
      );
      expect(await listIds(`${route}&branchId=${jed}`, managerBoth)).toEqual([]);
      await get(`${route}&branchId=${jed}`, managerDxb).expect(403);
    });
  });
});
