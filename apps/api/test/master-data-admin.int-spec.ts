import { randomInt } from 'node:crypto';
import type {
  AuditLogDto,
  CodeNameDto,
  CurrencyDto,
  CustomerDto,
  MasterDataDto,
  RateCardDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeEntityId } from '../src/audit/audit.service.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const suffix = () =>
  Array.from({ length: 5 }, () => LETTERS[randomInt(0, LETTERS.length)] ?? 'Z').join('');

describe('master data screens: container, charge and document types, currencies', () => {
  let t: TestApp;
  let dxb: string;
  let jebelAli: string;
  let portSudan: string;
  const cookies = { admin: '', manager: '', pricing: '', sales: '' };
  let adminId = '';
  // Codes of this run; the currency is three letters, one no other row has.
  const container = `ZC${suffix()}`.slice(0, 10);
  const charge = `ZCH${suffix()}`;
  const docType = `ZZ_${suffix()}`;
  let currency = '';

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  const master = async () =>
    (await get('/master-data', cookies.sales).expect(200)).body as MasterDataDto;

  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const auditLog = async (cookie: string, query: string) =>
    (
      (await get(`/reports/audit-log?from=${day(-1)}&to=${day(1)}&${query}`, cookie).expect(200))
        .body as AuditLogDto
    ).entries;

  let rateDay = randomInt(0, 6000);
  const rateBody = (overrides: object = {}) => ({
    branchId: dxb,
    originLocationId: jebelAli,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'FCL',
    cargoType: 'CONTAINER',
    containerTypeCode: container,
    chargeTypeCode: charge,
    unit: 'PER_CONTAINER',
    price: '100.00',
    minimumCharge: '0',
    currency,
    validFrom: new Date(Date.UTC(2000, 0, 1) + rateDay++ * 86_400_000).toISOString().slice(0, 10),
    validTo: '2099-12-31',
    ...overrides,
  });

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jebelAli = await loc('AEJEA');
    portSudan = await loc('SDPZU');
    const admin = await createUser(t.prisma, ['ADMINISTRATOR']);
    adminId = admin.id;
    cookies.admin = await signIn(t, admin.email);
    // A branch manager reads master data and the audit log but changes neither.
    cookies.manager = await signIn(
      t,
      (await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB'])).email,
    );
    cookies.pricing = await signIn(
      t,
      (await createUser(t.prisma, ['SALES_MARKETING_MANAGER'], ['DXB'])).email,
    );
    cookies.sales = await signIn(t, (await createUser(t.prisma, ['SALES'], ['DXB'])).email);
    do {
      currency = `X${suffix().slice(0, 2)}`;
    } while (await t.prisma.currency.findUnique({ where: { code: currency } }));
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await t.prisma.containerType.deleteMany({ where: { code: container } });
    await t.prisma.chargeType.deleteMany({ where: { code: charge } });
    await t.prisma.documentType.deleteMany({ where: { code: docType } });
    await t.prisma.currency.deleteMany({ where: { code: currency } });
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('who may change it', () => {
    it('refuses every write without master_data:create or :update', async () => {
      const body = { code: 'ZZNOPE', nameEn: 'No', nameAr: 'لا' };
      for (const path of ['container-types', 'charge-types', 'document-types']) {
        await post(`/master-data/${path}`, cookies.manager, body).expect(403);
        await patch(`/master-data/${path}/20GP`, cookies.manager, { nameEn: 'X' }).expect(403);
        await post(`/master-data/${path}/20GP/deactivate`, cookies.manager).expect(403);
        await post(`/master-data/${path}/20GP/reactivate`, cookies.pricing).expect(403);
      }
      await post('/master-data/currencies', cookies.manager, {
        code: 'XQQ',
        nameEn: 'No',
        nameAr: 'لا',
        decimalPlaces: 2,
      }).expect(403);
      await patch('/master-data/currencies/SDG', cookies.sales, { nameEn: 'X' }).expect(403);
      await post('/master-data/currencies/SDG/deactivate', cookies.manager).expect(403);
      await t
        .http()
        .post('/api/v1/master-data/container-types')
        .set('Origin', APP_ORIGIN)
        .send(body)
        .expect(401);
      // Nothing changed.
      const data = await master();
      expect(data.containerTypes.find((c) => c.code === '20GP')?.isActive).toBe(true);
      expect(data.currencies.find((c) => c.code === 'SDG')?.nameEn).not.toBe('X');
      expect(await t.prisma.containerType.count({ where: { code: 'ZZNOPE' } })).toBe(0);
    });
  });

  describe('adding and editing', () => {
    it('adds each master, active, and refuses a code already in use', async () => {
      const added = (
        await post('/master-data/container-types', cookies.admin, {
          code: container.toLowerCase(),
          nameEn: 'Test box',
          nameAr: 'حاوية تجربة',
        }).expect(201)
      ).body as CodeNameDto;
      expect(added).toEqual({
        code: container,
        nameEn: 'Test box',
        nameAr: 'حاوية تجربة',
        isActive: true,
      });
      await post('/master-data/charge-types', cookies.admin, {
        code: charge,
        nameEn: 'Test charge',
        nameAr: 'رسم تجربة',
      }).expect(201);
      await post('/master-data/document-types', cookies.admin, {
        code: docType,
        nameEn: 'Test paper',
        nameAr: 'مستند تجربة',
      }).expect(201);
      const money = (
        await post('/master-data/currencies', cookies.admin, {
          code: currency,
          nameEn: 'Test money',
          nameAr: 'عملة تجربة',
          symbol: 'T$',
          decimalPlaces: 3,
        }).expect(201)
      ).body as CurrencyDto;
      expect(money).toMatchObject({
        code: currency,
        decimalPlaces: 3,
        symbol: 'T$',
        isActive: true,
      });

      const taken = await post('/master-data/container-types', cookies.admin, {
        code: container,
        nameEn: 'Again',
        nameAr: 'مرة أخرى',
      }).expect(409);
      expect(taken.body).toMatchObject({ code: 'MASTER_CODE_TAKEN', params: { code: container } });
      await post('/master-data/currencies', cookies.admin, {
        code: 'USD',
        nameEn: 'Again',
        nameAr: 'مرة أخرى',
        decimalPlaces: 2,
      }).expect(409);
      // A new entry starts active: the add form takes no isActive.
      await post('/master-data/charge-types', cookies.admin, {
        code: 'ZZOFF',
        nameEn: 'Off',
        nameAr: 'معطل',
        isActive: false,
      }).expect(400);

      const data = await master();
      expect(data.containerTypes.map((c) => c.code)).toContain(container);
      expect(data.chargeTypes.map((c) => c.code)).toContain(charge);
      expect(data.documentTypes.map((c) => c.code)).toContain(docType);
      expect(data.currencies.map((c) => c.code)).toContain(currency);
    });

    it('renames, but never changes a code or a currency’s decimal places', async () => {
      const renamed = (
        await patch(`/master-data/container-types/${container}`, cookies.admin, {
          nameEn: 'Test box 2',
        }).expect(200)
      ).body as CodeNameDto;
      expect(renamed).toMatchObject({
        code: container,
        nameEn: 'Test box 2',
        nameAr: 'حاوية تجربة',
      });

      await patch(`/master-data/container-types/${container}`, cookies.admin, {
        code: 'ZZOTHER',
      }).expect(400);
      await patch(`/master-data/charge-types/${charge}`, cookies.admin, {
        code: 'ZZOTHER',
        nameEn: 'X',
      }).expect(400);
      await patch(`/master-data/currencies/${currency}`, cookies.admin, {
        decimalPlaces: 2,
      }).expect(400);
      await patch(`/master-data/currencies/${currency}`, cookies.admin, { code: 'XZZ' }).expect(
        400,
      );
      const money = (
        await patch(`/master-data/currencies/${currency}`, cookies.admin, { symbol: '' }).expect(
          200,
        )
      ).body as CurrencyDto;
      expect(money).toMatchObject({ code: currency, symbol: null, decimalPlaces: 3 });

      await patch('/master-data/document-types/ZZ_NO_SUCH_TYPE', cookies.admin, {
        nameEn: 'X',
      }).expect(404);
      await post('/master-data/currencies/XZQ/deactivate', cookies.admin).expect(404);
    });

    it('writes each change to the audit log, before and after, by code', async () => {
      const entries = await auditLog(cookies.admin, `userId=${adminId}&entity=CONTAINER_TYPE`);
      const mine = entries.filter((e) => e.reference.startsWith(`${container} `));
      expect(mine.map((e) => e.action)).toEqual(['UPDATED', 'CREATED']);
      expect(mine[0]?.changes).toEqual([
        { field: 'nameEn', before: 'Test box', after: 'Test box 2' },
      ]);
      expect(mine[1]?.changes).toEqual(
        expect.arrayContaining([
          { field: 'code', before: null, after: container },
          { field: 'isActive', before: null, after: 'true' },
        ]),
      );
      expect(mine.every((e) => e.branchCode === '—' && e.source === 'USER')).toBe(true);

      const rows = await t.prisma.auditEvent.findMany({
        where: { entity: 'CURRENCY', reference: { startsWith: `${currency} ` } },
        orderBy: { id: 'asc' },
      });
      expect(rows.map((r) => r.action)).toEqual(['CREATED', 'UPDATED']);
      expect(rows.every((r) => r.entityId === codeEntityId('CURRENCY', currency))).toBe(true);
      expect(rows.every((r) => r.userId === adminId && r.branchId === null)).toBe(true);
      expect(rows[1]?.changes).toEqual([{ field: 'symbol', before: 'T$', after: null }]);

      // Master data is no branch's: a branch manager who reads the log sees it, but not in a
      // single branch's view.
      const managers = await auditLog(cookies.manager, `entity=CHARGE_TYPE`);
      expect(managers.some((e) => e.reference.startsWith(`${charge} `))).toBe(true);
      expect(await auditLog(cookies.manager, `entity=CHARGE_TYPE&branchId=${dxb}`)).toEqual([]);
    });
  });

  describe('deactivating', () => {
    let oldRate: RateCardDto;

    it('refuses to deactivate the base currency', async () => {
      const res = await post('/master-data/currencies/USD/deactivate', cookies.admin).expect(400);
      expect(res.body).toMatchObject({ code: 'BASE_CURRENCY_STAYS_ACTIVE' });
      expect((await master()).currencies.find((c) => c.code === 'USD')?.isActive).toBe(true);
    });

    it('keeps records already made, and refuses new ones while inactive', async () => {
      // A rate card made while all three were active.
      const draft = (await post('/rates', cookies.pricing, rateBody()).expect(201))
        .body as RateCardDto;
      oldRate = (await post(`/rates/${draft.id}/approve`, cookies.pricing).expect(200))
        .body as RateCardDto;

      for (const path of [
        `container-types/${container}`,
        `charge-types/${charge}`,
        `document-types/${docType}`,
        `currencies/${currency}`,
      ]) {
        const res = await post(`/master-data/${path}/deactivate`, cookies.admin).expect(200);
        expect((res.body as CodeNameDto).isActive).toBe(false);
      }
      // Deactivating twice changes nothing and logs nothing more.
      await post(`/master-data/currencies/${currency}/deactivate`, cookies.admin).expect(200);
      expect(
        await t.prisma.auditEvent.count({
          where: { entity: 'CURRENCY', reference: { startsWith: `${currency} ` } },
        }),
      ).toBe(3);

      // Listed (for reading old records), marked inactive.
      const data = await master();
      expect(data.containerTypes.find((c) => c.code === container)?.isActive).toBe(false);
      expect(data.currencies.find((c) => c.code === currency)?.isActive).toBe(false);

      // The old rate card still reads, with its codes.
      const read = (await get(`/rates/${oldRate.id}`, cookies.pricing).expect(200))
        .body as RateCardDto;
      expect(read).toMatchObject({
        containerTypeCode: container,
        chargeTypeCode: charge,
        currency,
        status: 'APPROVED',
      });

      // New rate cards with any of them are refused, each for its own reason.
      const refused = async (res: Promise<{ body: unknown }>, reason: RegExp) =>
        expect(JSON.stringify((await res).body)).toMatch(reason);
      await refused(
        post(
          '/rates',
          cookies.pricing,
          rateBody({ chargeTypeCode: 'FREIGHT', currency: 'USD' }),
        ).expect(400),
        /inactive container type/,
      );
      await refused(
        post(
          '/rates',
          cookies.pricing,
          rateBody({ containerTypeCode: '40HC', currency: 'USD' }),
        ).expect(400),
        /inactive charge type/,
      );
      await refused(
        post(
          '/rates',
          cookies.pricing,
          rateBody({ containerTypeCode: '40HC', chargeTypeCode: 'FREIGHT' }),
        ).expect(400),
        /inactive currency/,
      );

      // A new customer or quotation in the inactive currency is refused.
      await refused(
        post('/customers', cookies.sales, {
          branchId: dxb,
          kind: 'COMPANY',
          name: 'Inactive Currency Trading',
          companyName: 'Inactive Currency Trading LLC',
          phone: uniquePhone(),
          preferredCurrency: currency,
        }).expect(400),
        /inactive currency/,
      );
      const customer = (
        await post('/customers', cookies.sales, {
          branchId: dxb,
          kind: 'COMPANY',
          name: 'Active Currency Trading',
          companyName: 'Active Currency Trading LLC',
          phone: uniquePhone(),
          preferredCurrency: 'USD',
        }).expect(201)
      ).body as CustomerDto;
      await refused(
        post('/quotations', cookies.sales, {
          customerId: customer.id,
          originLocationId: jebelAli,
          destinationLocationId: portSudan,
          mode: 'SEA',
          loadType: 'FCL',
          cargoType: 'CONTAINER',
          currency,
          validUntil: '2099-12-31',
          lines: [
            { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '10' },
          ],
        }).expect(400),
        /CURRENCY_NOT_ACTIVE|inactive currency/,
      );
      // A manual quotation line with the inactive charge type, in an active currency.
      await refused(
        post('/quotations', cookies.sales, {
          customerId: customer.id,
          originLocationId: jebelAli,
          destinationLocationId: portSudan,
          mode: 'SEA',
          loadType: 'FCL',
          cargoType: 'CONTAINER',
          currency: 'USD',
          validUntil: '2099-12-31',
          lines: [{ chargeTypeCode: charge, unit: 'PER_SHIPMENT', quantity: '1', unitPrice: '10' }],
        }).expect(400),
        /UNKNOWN_CHARGE_TYPE|inactive charge type/,
      );

      // A booking's container line of the inactive type is refused; the same with 20GP is not.
      const booking = (containerTypeCode: string) => ({
        customerId: customer.id,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'FCL',
        cargoType: 'CONTAINER',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'CONTAINER', containerTypeCode, quantity: 1 }],
      });
      expect(
        (await post('/bookings', cookies.sales, booking(container)).expect(400)).body,
      ).toMatchObject({ fields: ['items.0.containerTypeCode'] });
      await post('/bookings', cookies.sales, booking('20GP')).expect(201);

      // A new file of the inactive document type is refused before anything is stored.
      await expect(
        t.app.get(DocumentsService).prepare({
          typeCode: docType,
          fileName: 'a.pdf',
          note: null,
          data: Buffer.from('%PDF-1.4\n'),
        }),
      ).rejects.toThrow(/inactive document type/);
    });

    it('takes new records again once reactivated', async () => {
      for (const path of [
        `container-types/${container}`,
        `charge-types/${charge}`,
        `currencies/${currency}`,
      ]) {
        await post(`/master-data/${path}/reactivate`, cookies.admin).expect(200);
      }
      await post('/rates', cookies.pricing, rateBody()).expect(201);
      const log = await auditLog(cookies.admin, `entity=CURRENCY&userId=${adminId}`);
      const mine = log.filter((e) => e.reference.startsWith(`${currency} `));
      expect(mine[0]?.changes).toEqual([{ field: 'isActive', before: 'false', after: 'true' }]);
      expect(mine[1]?.changes).toEqual([{ field: 'isActive', before: 'true', after: 'false' }]);
    });
  });
});
