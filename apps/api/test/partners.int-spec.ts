import type {
  AuditLogDto,
  MasterDataDto,
  Page,
  PartnerDto,
  PartnerSummaryDto,
  PriceCategoryDto,
} from '@nolon/shared';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Business model batch 1 (docs/plans/02-business-model-batch-1.md): partners of the network,
// branch-owned, and the price categories and customer segments masters. No commission, accrual,
// journal entry or settlement exists yet.
describe('partners, price categories and customer segments', () => {
  let t: TestApp;
  let dxb: string;
  let jed: string;
  let jeddahPort: string;
  let portSudan: string;
  const cookies = { admin: '', dxbManager: '', jedManager: '', dxbSales: '', warehouse: '' };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  const outlet = (overrides: object = {}) => ({
    kind: 'SALES_OUTLET',
    branchId: jed,
    name: `ZZ outlet ${suffix()}`,
    phone: uniquePhone(),
    countryCode: 'SA',
    locationId: jeddahPort,
    currency: 'SAR',
    ...overrides,
  });

  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    t = await createTestApp();
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    cookies.admin = await signIn(t, (await createUser(t.prisma, ['ADMINISTRATOR'])).email);
    cookies.dxbManager = await signIn(
      t,
      (await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB'])).email,
    );
    cookies.jedManager = await signIn(
      t,
      (await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'])).email,
    );
    cookies.dxbSales = await signIn(t, (await createUser(t.prisma, ['SALES'], ['DXB'])).email);
    cookies.warehouse = await signIn(t, (await createUser(t.prisma, ['WAREHOUSE'], ['JED'])).email);
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await t.prisma.priceCategory.deleteMany({ where: { code: { startsWith: 'ZZ' } } });
    await t.prisma.customerSegment.deleteMany({ where: { code: { startsWith: 'ZZ' } } });
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('partners', () => {
    it('creates a partner in the user’s branch, numbered, and logs it', async () => {
      const res = await post('/partners', cookies.jedManager, outlet()).expect(201);
      const partner = res.body as PartnerDto;
      expect(partner.number).toMatch(/^NOL-PTR-\d{6}$/);
      expect(partner).toMatchObject({
        kind: 'SALES_OUTLET',
        branchId: jed,
        countryCode: 'SA',
        locationId: jeddahPort,
        currency: 'SAR',
        isActive: true,
        supplierId: null,
        actions: { canEdit: true },
      });
      const log = (
        (
          await get(
            `/reports/audit-log?from=${day(-1)}&to=${day(1)}&entity=PARTNER`,
            cookies.jedManager,
          ).expect(200)
        ).body as AuditLogDto
      ).entries;
      expect(
        log.some((e) => e.reference.startsWith(partner.number) && e.action === 'CREATED'),
      ).toBe(true);
    });

    it('keeps partners of another branch hidden (404) and refuses writes there (403)', async () => {
      const partner = (await post('/partners', cookies.jedManager, outlet()).expect(201))
        .body as PartnerDto;
      await get(`/partners/${partner.id}`, cookies.dxbManager).expect(404);
      await patch(`/partners/${partner.id}`, cookies.dxbManager, { name: 'ZZ taken' }).expect(404);
      await post('/partners', cookies.dxbManager, outlet({ branchId: jed })).expect(403);
      const list = (await get('/partners?pageSize=100', cookies.dxbManager).expect(200))
        .body as Page<PartnerSummaryDto>;
      expect(list.items.every((p) => p.branchId === dxb)).toBe(true);
      expect(list.items.some((p) => p.id === partner.id)).toBe(false);
      // A list filtered on a branch the user does not hold is refused, not emptied.
      await get(`/partners?branchId=${jed}`, cookies.dxbManager).expect(403);
      // The administrator sees every branch.
      await get(`/partners/${partner.id}`, cookies.admin).expect(200);
    });

    it('lets Sales read but not write, and keeps Warehouse out', async () => {
      const partner = (
        await post('/partners', cookies.dxbManager, outlet({ branchId: dxb })).expect(201)
      ).body as PartnerDto;
      const read = (await get(`/partners/${partner.id}`, cookies.dxbSales).expect(200))
        .body as PartnerDto;
      expect(read.actions.canEdit).toBe(false);
      await post('/partners', cookies.dxbSales, outlet({ branchId: dxb })).expect(403);
      await patch(`/partners/${partner.id}`, cookies.dxbSales, { name: 'ZZ no' }).expect(403);
      await get('/partners', cookies.warehouse).expect(403);
    });

    it('refuses a city or port outside the partner’s country, on create and on edit', async () => {
      const refused = await post(
        '/partners',
        cookies.jedManager,
        outlet({ countryCode: 'SA', locationId: portSudan }),
      ).expect(400);
      expect(refused.body).toMatchObject({ code: 'PARTNER_LOCATION_OTHER_COUNTRY' });
      const partner = (await post('/partners', cookies.jedManager, outlet()).expect(201))
        .body as PartnerDto;
      const moved = await patch(`/partners/${partner.id}`, cookies.jedManager, {
        countryCode: 'SD',
      }).expect(400);
      expect(moved.body).toMatchObject({ code: 'PARTNER_LOCATION_OTHER_COUNTRY' });
      // A distributor in Sudan, at Port Sudan, in SDG.
      const distributor = (
        await patch(`/partners/${partner.id}`, cookies.jedManager, {
          kind: 'DISTRIBUTOR',
          countryCode: 'SD',
          locationId: portSudan,
          currency: 'SDG',
        }).expect(200)
      ).body as PartnerDto;
      expect(distributor).toMatchObject({
        kind: 'DISTRIBUTOR',
        countryCode: 'SD',
        currency: 'SDG',
      });
    });

    it('fixes the branch, refuses unknown references, and deactivates instead of deleting', async () => {
      const partner = (await post('/partners', cookies.jedManager, outlet()).expect(201))
        .body as PartnerDto;
      await patch(`/partners/${partner.id}`, cookies.jedManager, { branchId: dxb }).expect(400);
      await post('/partners', cookies.jedManager, outlet({ currency: 'XXX' })).expect(400);
      await post('/partners', cookies.jedManager, outlet({ kind: 'BROKER' })).expect(400);
      await post(
        '/partners',
        cookies.jedManager,
        outlet({ supplierId: '00000000-0000-4000-8000-000000000000' }),
      ).expect(404);
      const off = (
        await patch(`/partners/${partner.id}`, cookies.jedManager, { isActive: false }).expect(200)
      ).body as PartnerDto;
      expect(off.isActive).toBe(false);
      const inactive = (
        await get('/partners?isActive=false&pageSize=100', cookies.jedManager).expect(200)
      ).body as Page<PartnerSummaryDto>;
      expect(inactive.items.some((p) => p.id === partner.id)).toBe(true);
    });

    it('keeps a partner editable after its city is deactivated; a new city must be active', async () => {
      const city = await t.prisma.location.create({
        data: {
          code: `ZZ${suffix().slice(-6).toUpperCase()}`,
          kind: 'CITY',
          nameEn: 'ZZ city',
          nameAr: 'مدينة',
          countryCode: 'SA',
        },
      });
      const partner = (
        await post('/partners', cookies.jedManager, outlet({ locationId: city.id })).expect(201)
      ).body as PartnerDto;
      await t.prisma.location.update({ where: { id: city.id }, data: { isActive: false } });
      // The held city stays: renaming and deactivating still work, with the whole form (the city
      // sent back as it is) or with only the changed field.
      await patch(`/partners/${partner.id}`, cookies.jedManager, {
        name: 'ZZ full form',
        countryCode: 'SA',
        locationId: city.id,
        currency: 'SAR',
      }).expect(200);
      await patch(`/partners/${partner.id}`, cookies.jedManager, { name: 'ZZ renamed' }).expect(
        200,
      );
      const off = (
        await patch(`/partners/${partner.id}`, cookies.jedManager, { isActive: false }).expect(200)
      ).body as PartnerDto;
      expect(off).toMatchObject({ isActive: false, locationId: city.id, name: 'ZZ renamed' });
      // The held city is still checked against a changed country.
      await patch(`/partners/${partner.id}`, cookies.jedManager, { countryCode: 'SD' }).expect(400);
      // A newly named inactive city is refused, on edit and on create.
      const other = (await post('/partners', cookies.jedManager, outlet()).expect(201))
        .body as PartnerDto;
      await patch(`/partners/${other.id}`, cookies.jedManager, { locationId: city.id }).expect(400);
      await post('/partners', cookies.jedManager, outlet({ locationId: city.id })).expect(400);
    });

    it('pages the list', async () => {
      await post('/partners', cookies.jedManager, outlet()).expect(201);
      await post('/partners', cookies.jedManager, outlet()).expect(201);
      const first = (await get('/partners?pageSize=1&page=1', cookies.jedManager).expect(200))
        .body as Page<PartnerSummaryDto>;
      const second = (await get('/partners?pageSize=1&page=2', cookies.jedManager).expect(200))
        .body as Page<PartnerSummaryDto>;
      expect(first.total).toBeGreaterThanOrEqual(2);
      expect(first.items).toHaveLength(1);
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    });

    it('creates no journal entry or supplier bill (commissions are not in this batch)', async () => {
      const before = await Promise.all([
        t.prisma.journalEntry.count(),
        t.prisma.supplierBill.count(),
      ]);
      await post('/partners', cookies.jedManager, outlet()).expect(201);
      const after = await Promise.all([
        t.prisma.journalEntry.count(),
        t.prisma.supplierBill.count(),
      ]);
      expect(after).toEqual(before);
    });
  });

  describe('price categories and customer segments', () => {
    it('ships the seeded categories and segments in GET /master-data', async () => {
      const master = (await get('/master-data', cookies.dxbSales).expect(200))
        .body as MasterDataDto;
      expect(master.priceCategories.map((c) => c.code)).toEqual(
        expect.arrayContaining(['CARTON', 'BARREL', 'PALLET', 'SPECIAL']),
      );
      expect(master.priceCategories.find((c) => c.code === 'CARTON')).toMatchObject({
        cargoType: 'GENERAL',
        defaultUnit: 'PER_PIECE',
        isActive: true,
      });
      expect(master.customerSegments.map((c) => c.code)).toEqual(
        expect.arrayContaining(['INDIVIDUAL', 'MERCHANT', 'BUSINESS']),
      );
    });

    it('adds, edits and deactivates a price category; its code and cargo type stay', async () => {
      const code = `ZZ${suffix()}`;
      const created = (
        await post('/master-data/price-categories', cookies.admin, {
          code: code.toLowerCase(),
          nameEn: 'Drum',
          nameAr: 'درم',
          cargoType: 'BARREL',
          defaultUnit: 'PER_BARREL',
        }).expect(201)
      ).body as PriceCategoryDto;
      expect(created).toMatchObject({ code, cargoType: 'BARREL', isActive: true });
      await post('/master-data/price-categories', cookies.admin, {
        code,
        nameEn: 'Again',
        nameAr: 'مرة',
        cargoType: 'BARREL',
        defaultUnit: 'PER_BARREL',
      })
        .expect(409)
        .expect((r) => expect(r.body).toMatchObject({ code: 'MASTER_CODE_TAKEN' }));
      await patch(`/master-data/price-categories/${code}`, cookies.admin, {
        cargoType: 'PALLET',
      }).expect(400);
      const edited = (
        await patch(`/master-data/price-categories/${code}`, cookies.admin, {
          defaultUnit: 'PER_SHIPMENT',
        }).expect(200)
      ).body as PriceCategoryDto;
      expect(edited).toMatchObject({ cargoType: 'BARREL', defaultUnit: 'PER_SHIPMENT' });
      const off = (
        await post(`/master-data/price-categories/${code}/deactivate`, cookies.admin).expect(200)
      ).body as PriceCategoryDto;
      expect(off.isActive).toBe(false);
      await post(`/master-data/price-categories/${code}/reactivate`, cookies.admin).expect(200);
      await post('/master-data/price-categories/ZZNONE/deactivate', cookies.admin).expect(404);
    });

    it('adds, renames and deactivates a customer segment', async () => {
      const code = `ZZ${suffix()}`;
      await post('/master-data/customer-segments', cookies.admin, {
        code,
        nameEn: 'NGOs',
        nameAr: 'منظمات',
      }).expect(201);
      await patch(`/master-data/customer-segments/${code}`, cookies.admin, {
        nameEn: 'Organisations',
      }).expect(200);
      await post(`/master-data/customer-segments/${code}/deactivate`, cookies.admin).expect(200);
      const master = (await get('/master-data', cookies.admin).expect(200)).body as MasterDataDto;
      expect(master.customerSegments.find((s) => s.code === code)).toMatchObject({
        nameEn: 'Organisations',
        isActive: false,
      });
    });

    it('lets only master_data:create/update holders change them', async () => {
      await post('/master-data/price-categories', cookies.dxbManager, {
        code: `ZZ${suffix()}`,
        nameEn: 'No',
        nameAr: 'لا',
        cargoType: 'GENERAL',
        defaultUnit: 'PER_PIECE',
      }).expect(403);
      await post('/master-data/customer-segments', cookies.dxbSales, {
        code: `ZZ${suffix()}`,
        nameEn: 'No',
        nameAr: 'لا',
      }).expect(403);
      await post('/master-data/price-categories/CARTON/deactivate', cookies.dxbManager).expect(403);
    });
  });
});
