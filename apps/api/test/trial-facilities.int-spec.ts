import type { WarehouseDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/auth-user.js';
import { MasterDataService } from '../src/master-data/master-data.service.js';
import { SOFT_LAUNCH_PLACES, softLaunchActor } from '../src/seed/soft-launch.js';
import {
  ADDABLE_PLACES,
  TRIAL_ADDRESS_PREFIX,
  TRIAL_DROP_OFF_CODES,
  TRIAL_FACILITIES,
  TRIAL_HOURS_AR,
  TRIAL_HOURS_EN,
  type TrialFacilitiesDeps,
  applyTrialDropOff,
  applyTrialFacilities,
} from '../src/seed/trial-facilities.js';
import { WarehousesService } from '../src/warehouse/warehouses.service.js';
import {
  type TestApp,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';

/**
 * The trial facilities script (seed/trial-facilities.ts) against PostgreSQL: it adds every
 * facility with its kind, phone and map position, a second run changes nothing, a facility staff
 * turned off stays off, a place staff turned off is never turned back on (its facilities wait),
 * and GET /warehouses shows the details within the user's branches only. What it adds is undone
 * afterwards.
 */
describe('trial-facilities data script', () => {
  let t: TestApp;
  let deps: TrialFacilitiesDeps;
  let actor: AuthUser;
  const codes = [...new Set(TRIAL_FACILITIES.map((f) => f.place))];
  const before = new Map<string, boolean>();

  beforeAll(async () => {
    t = await createTestApp();
    const masterData = t.app.get(MasterDataService);
    deps = { prisma: t.prisma, masterData, warehouses: t.app.get(WarehousesService) };
    // Not an it- user: users who made warehouses are kept with them.
    const email = (await createUser(t.prisma, ['ADMINISTRATOR'], [], 'trial-facilities-it-')).email;
    actor = await softLaunchActor(t.prisma, email);
    await t.prisma.warehouse.deleteMany({ where: { code: { startsWith: 'TR-' } } });
    // The places the facilities need, active (as on staging), except Suakin, which the script adds.
    for (const spec of SOFT_LAUNCH_PLACES.filter((p) => codes.includes(p.code))) {
      const place = await t.prisma.location.findUnique({ where: { code: spec.code } });
      before.set(spec.code, place?.isActive ?? false);
      if (!place) {
        await masterData.createLocation(actor, {
          code: spec.code,
          kind: spec.kind,
          nameEn: spec.nameEn,
          nameAr: spec.nameAr,
          countryCode: spec.countryCode,
        });
      } else if (!place.isActive) {
        await t.prisma.location.update({ where: { id: place.id }, data: { isActive: true } });
      }
    }
    for (const spec of ADDABLE_PLACES) {
      const place = await t.prisma.location.findUnique({ where: { code: spec.code } });
      before.set(spec.code, place?.isActive ?? false);
      if (place && !place.isActive) {
        await t.prisma.location.update({ where: { id: place.id }, data: { isActive: true } });
      }
    }
  });

  afterAll(async () => {
    if (!t) return;
    await t.prisma.warehouse.deleteMany({ where: { code: { startsWith: 'TR-' } } });
    for (const [code, isActive] of before) {
      await t.prisma.location.updateMany({ where: { code }, data: { isActive } });
    }
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('skips the facilities of a place staff turned off, and never turns it back on', async () => {
    await t.prisma.location.update({ where: { code: 'SDDOG' }, data: { isActive: false } });
    const atDongola = TRIAL_FACILITIES.filter((f) => f.place === 'SDDOG');
    expect(atDongola).toHaveLength(2);
    const report = await applyTrialFacilities(deps, actor);
    expect(report).toContain('مكان موقوف: دنقلا (SDDOG)، مراكزه لم تُدخل');
    expect(report).toContain(
      `مراكز جديدة: ${TRIAL_FACILITIES.length - 2} من ${TRIAL_FACILITIES.length}`,
    );
    const dongola = await t.prisma.location.findUniqueOrThrow({ where: { code: 'SDDOG' } });
    expect(dongola.isActive).toBe(false);
    expect(
      await t.prisma.warehouse.count({ where: { code: { in: atDongola.map((f) => f.code) } } }),
    ).toBe(0);
    await t.prisma.location.update({ where: { code: 'SDDOG' }, data: { isActive: true } });
  });

  it('adds every facility with its kind, phone, map position and trial marks', async () => {
    await applyTrialFacilities(deps, actor);
    const rows = await t.prisma.warehouse.findMany({
      where: { code: { startsWith: 'TR-' } },
      include: { branch: true, location: true },
    });
    expect(rows).toHaveLength(TRIAL_FACILITIES.length);
    for (const f of TRIAL_FACILITIES) {
      const w = rows.find((r) => r.code === f.code);
      expect(w, f.code).toBeDefined();
      expect(w?.kind).toBe(f.kind);
      expect(w?.phone).toBe(f.phone);
      expect(w?.latitude?.toFixed(6)).toBe(f.latitude);
      expect(w?.longitude?.toFixed(6)).toBe(f.longitude);
      expect(w?.branch.code).toBe(f.branchCode);
      expect(w?.location?.code).toBe(f.place);
      expect(w?.nameAr).toBe(`${f.nameAr} (تجريبي)`);
      expect(w?.nameEn).toBe(`${f.nameEn} (trial)`);
      expect(w?.address?.startsWith(TRIAL_ADDRESS_PREFIX)).toBe(true);
      expect(w?.isActive).toBe(true);
    }
    for (const spec of ADDABLE_PLACES) {
      const place = await t.prisma.location.findUniqueOrThrow({ where: { code: spec.code } });
      expect(place).toMatchObject({ kind: 'CITY', countryCode: spec.countryCode, isActive: true });
    }
  });

  it('a second run changes nothing, and a facility staff turned off stays off', async () => {
    await t.prisma.warehouse.update({
      where: { code: 'TR-JED-W2' },
      data: { isActive: false, phone: '+966511111111' },
    });
    const snapshot = await t.prisma.warehouse.findMany({
      where: { code: { startsWith: 'TR-' } },
      orderBy: { code: 'asc' },
    });
    const report = await applyTrialFacilities(deps, actor);
    expect(report).toContain(`مراكز جديدة: 0 من ${TRIAL_FACILITIES.length}`);
    expect(report).toContain('موجود، تُرك: نافذة استلام جدة - البلد (TR-JED-W2)، موقوف');
    const after = await t.prisma.warehouse.findMany({
      where: { code: { startsWith: 'TR-' } },
      orderBy: { code: 'asc' },
    });
    expect(after).toEqual(snapshot);
  });

  it('marks the origin facilities as drop-off points once, leaving what staff set (plan 09 section 11)', async () => {
    // Staff already gave one its own hours; TR-JED-W2 is off (previous test).
    await t.prisma.warehouse.update({ where: { code: 'TR-DXB-W1' }, data: { hoursAr: 'من 8' } });
    const report = await applyTrialDropOff(deps, actor);
    expect(report).toContain('نقطة تسليم، تُركت كما هي: TR-JED-W2');
    expect(report).toContain('نقطة تسليم، تُركت كما هي: TR-DXB-W1');
    expect(report).toContain(
      `نقاط تسليم جديدة: ${TRIAL_DROP_OFF_CODES.length - 2} من ${TRIAL_DROP_OFF_CODES.length}`,
    );
    const rows = await t.prisma.warehouse.findMany({ where: { code: { startsWith: 'TR-' } } });
    for (const w of rows) {
      const marked =
        TRIAL_DROP_OFF_CODES.includes(w.code) && !['TR-JED-W2', 'TR-DXB-W1'].includes(w.code);
      expect(w.acceptsDropOff, w.code).toBe(marked);
      if (marked) expect([w.hoursAr, w.hoursEn], w.code).toEqual([TRIAL_HOURS_AR, TRIAL_HOURS_EN]);
    }
    expect(rows.find((w) => w.code === 'TR-DXB-W1')?.hoursAr).toBe('من 8');
    // Through the service, so each change is in the log.
    const marked = rows.find((w) => w.code === 'TR-JED-CC');
    expect(
      await t.prisma.auditEvent.count({ where: { entity: 'WAREHOUSE', entityId: marked?.id } }),
    ).toBeGreaterThan(0);
    // A second run changes nothing, and a point staff turned back off stays off.
    await t.prisma.warehouse.update({
      where: { code: 'TR-CAI-W1' },
      data: { acceptsDropOff: false },
    });
    const snapshot = await t.prisma.warehouse.findMany({
      where: { code: { startsWith: 'TR-' } },
      orderBy: { code: 'asc' },
    });
    expect(await applyTrialDropOff(deps, actor)).toContain(
      `نقاط تسليم جديدة: 0 من ${TRIAL_DROP_OFF_CODES.length}`,
    );
    expect(
      await t.prisma.warehouse.findMany({
        where: { code: { startsWith: 'TR-' } },
        orderBy: { code: 'asc' },
      }),
    ).toEqual(snapshot);
  });

  it('GET /warehouses shows the details, within the user’s branches only', async () => {
    const jed = await createUser(t.prisma, ['WAREHOUSE'], ['JED']);
    const cookie = await signIn(t, jed.email);
    const list = (await t.http().get('/api/v1/warehouses').set('Cookie', cookie).expect(200))
      .body as WarehouseDto[];
    const trial = list.filter((w) => w.code.startsWith('TR-'));
    expect(trial.map((w) => w.code).sort()).toEqual([
      'TR-JED-CC',
      'TR-JED-W1',
      'TR-JED-W2',
      'TR-RUH-W1',
      'TR-RUH-W2',
    ]);
    expect(trial.find((w) => w.code === 'TR-JED-CC')).toMatchObject({
      kind: 'COLLECTION_CENTER',
      phone: '+966500000101',
      latitude: '21.3715',
      longitude: '39.2268',
    });
  });
});
