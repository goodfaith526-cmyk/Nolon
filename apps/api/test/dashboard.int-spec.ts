import type { DashboardDto } from '@nolon/shared';
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
import { uniquePhone } from './test-data.js';

describe('dashboard', () => {
  let t: TestApp;
  let krt: string;
  let salesKrt: string;
  let salesAtb: string;
  let warehouse: string;
  let driver: string;

  const dashboard = async (cookie: string) =>
    (await t.http().get('/api/v1/dashboard').set('Cookie', cookie).expect(200))
      .body as DashboardDto;

  beforeAll(async () => {
    t = await createTestApp();
    krt = await branchId(t.prisma, 'KRT');
    salesKrt = await signIn(t, (await createUser(t.prisma, ['SALES'], ['KRT'])).email);
    salesAtb = await signIn(t, (await createUser(t.prisma, ['SALES'], ['ATB'])).email);
    warehouse = await signIn(t, (await createUser(t.prisma, ['WAREHOUSE'], ['KRT'])).email);
    driver = await signIn(t, (await createUser(t.prisma, ['DRIVER'], ['KRT'])).email);
    await t
      .http()
      .post('/api/v1/customers')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', salesKrt)
      .send({ branchId: krt, kind: 'INDIVIDUAL', name: 'Dashboard Test', phone: uniquePhone() })
      .expect(201);
  });

  afterAll(async () => {
    await t.prisma.customer.deleteMany({ where: { createdBy: { email: { startsWith: 'it-' } } } });
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('counts only the records of the user’s own branches', async () => {
    const atb = await branchId(t.prisma, 'ATB');
    const krtView = await dashboard(salesKrt);
    const atbView = await dashboard(salesAtb);
    expect(krtView.customers?.total).toBe(
      await t.prisma.customer.count({ where: { branchId: krt } }),
    );
    expect(atbView.customers?.total).toBe(
      await t.prisma.customer.count({ where: { branchId: atb } }),
    );
    expect(krtView.customers?.total).toBeGreaterThan(0);
    expect(krtView.quotations?.recent.every((q) => q.branchId === krt)).toBe(true);
    expect(krtView.bookings?.recent.every((b) => b.branchId === krt)).toBe(true);
  });

  it('leaves out the modules the user may not view', async () => {
    const view = await dashboard(warehouse);
    expect(view.customers).not.toBeNull();
    expect(view.bookings).not.toBeNull();
    expect(view.rates).toBeNull();
    expect(view.quotations).toBeNull();
    expect(await dashboard(driver)).toEqual({
      customers: null,
      rates: null,
      quotations: null,
      bookings: null,
    });
  });

  it('needs a session', async () => {
    await t.http().get('/api/v1/dashboard').expect(401);
  });
});
