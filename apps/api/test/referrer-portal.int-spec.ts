import { randomInt, randomUUID } from 'node:crypto';
import { REFERRER_DAILY_REFUSALS, type PartnerDto, type ReferrerPortalDto } from '@nolon/shared';
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

/**
 * Plan 18-4: the referral broker's own login (REFERRER_STAFF). It reaches only his screen, sees
 * only the customers he registered and adds one by name and phone; a phone already a customer's
 * is refused without saying whose, recorded with its last digits only, audited and limited to 20 a day.
 */
describe('Referral broker screen (plan 18-4)', () => {
  let t: TestApp;
  let jed = '';
  const cookies = { admin: '', manager: '', sales: '', broker: '', other: '' };
  let broker: PartnerDto;
  let brokerUser = '';

  const as = (cookie: string) => ({
    get: (path: string) => t.http().get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  const code = (body: unknown) => (body as { code?: string }).code;

  async function newBroker(name: string): Promise<PartnerDto> {
    return (
      await as(cookies.manager)
        .post('/partners', {
          kind: 'REFERRER',
          branchId: jed,
          name,
          phone: uniquePhone(),
          countryCode: 'SA',
          currency: 'SAR',
        })
        .expect(201)
    ).body as PartnerDto;
  }

  /** A login for `partner`, made by the Administrator through the users screen. */
  async function brokerLogin(partner: PartnerDto): Promise<{ id: string; cookie: string }> {
    const email = `it-${randomUUID()}@nolon.test`;
    const made = (
      await as(cookies.admin)
        .post('/users', {
          email,
          fullName: 'Broker login',
          password: 'Integration-Test-Password-1',
          preferredLocale: 'ar',
          roles: ['REFERRER_STAFF'],
          branchIds: [jed],
          outletIds: [partner.id],
        })
        .expect(201)
    ).body as { id: string };
    return { id: made.id, cookie: await signIn(t, email, 'Integration-Test-Password-1') };
  }

  beforeAll(async () => {
    t = await createTestApp();
    jed = await branchId(t.prisma, 'JED');
    cookies.admin = await signIn(t, (await createUser(t.prisma, ['ADMINISTRATOR'])).email);
    cookies.manager = await signIn(
      t,
      (await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED'])).email,
    );
    cookies.sales = await signIn(t, (await createUser(t.prisma, ['SALES'], ['JED'])).email);
    broker = await newBroker(`ZZ Ahmed broker ${randomInt(1000, 9999)}`);
    const login = await brokerLogin(broker);
    brokerUser = login.id;
    cookies.broker = login.cookie;
    cookies.other = (await brokerLogin(await newBroker('ZZ other broker'))).cookie;
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  it('reaches only his own screen and his account', async () => {
    const me = as(cookies.broker);
    await me.get('/auth/me').expect(200);
    // A route any signed-in user may reach (no permission) is closed to him too.
    await me.get('/assistant-drafts/mine').expect(403);
    for (const path of ['/customers', '/partners', '/shipments', '/bookings', '/master-data']) {
      await me.get(path).expect(403);
    }
    const shown = (await me.get('/referrer-portal').expect(200)).body as ReferrerPortalDto;
    expect(shown.broker).toMatchObject({ name: broker.name, referralCode: broker.referralCode });
    // Staff have no broker screen.
    await as(cookies.sales).get('/referrer-portal').expect(403);
    await as(cookies.admin).get('/referrer-portal').expect(403);
  });

  it('adds a new customer as his, and shows only his own, with the phone’s end', async () => {
    const phone = uniquePhone();
    const after = (
      await as(cookies.broker)
        .post('/referrer-portal/customers', { name: 'ZZ Mona Ali', phone })
        .expect(201)
    ).body as ReferrerPortalDto;
    expect(after.customers).toEqual([
      expect.objectContaining({ name: 'ZZ Mona Ali', phoneEnd: phone.slice(-3), shipments: 0 }),
    ]);
    const made = await t.prisma.customer.findFirstOrThrow({ where: { phone } });
    expect(made).toMatchObject({
      referredByPartnerId: broker.id,
      phoneUnverified: true,
      createdById: brokerUser,
    });
    expect(made.referredAt).not.toBeNull();
    // Another broker does not see it.
    const other = (await as(cookies.other).get('/referrer-portal').expect(200))
      .body as ReferrerPortalDto;
    expect(other.customers).toEqual([]);
    // Name and phone are required and checked.
    await as(cookies.broker)
      .post('/referrer-portal/customers', { name: 'ZZ x', phone: '0912' })
      .expect(400);
    await as(cookies.broker)
      .post('/referrer-portal/customers', { name: 'ZZ x', phone, kind: 'COMPANY' })
      .expect(400);
  });

  it('refuses a phone already a customer’s, audited without the phone, 20 times a day at most', async () => {
    const phone = uniquePhone();
    await as(cookies.sales)
      .post('/customers', { kind: 'INDIVIDUAL', name: 'ZZ existing', phone })
      .expect(201);
    const res = await as(cookies.other)
      .post('/referrer-portal/customers', { name: 'ZZ steal', phone })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'CUSTOMER_EXISTS' });
    // Never linked: the existing customer keeps no broker.
    expect(
      (await t.prisma.customer.findFirstOrThrow({ where: { phone } })).referredByPartnerId,
    ).toBeNull();
    const otherPartner = (
      await t.prisma.userPartner.findFirstOrThrow({
        where: { partner: { name: 'ZZ other broker', kind: 'REFERRER' } },
        orderBy: { partnerId: 'asc' },
      })
    ).partnerId;
    const attempts = await t.prisma.referrerCustomerAttempt.findMany({
      where: { partnerId: otherPartner },
    });
    expect(attempts).toEqual([
      expect.objectContaining({ refused: true, phoneEnd: phone.slice(-3) }),
    ]);
    const audit = await t.prisma.auditEvent.findMany({ where: { entityId: otherPartner } });
    const logged = JSON.stringify(audit.map((a) => a.changes));
    expect(logged).toContain(`phone ending ${phone.slice(-3)}`);
    expect(logged).not.toContain(phone);

    // The rest of today's refusals, then the limit.
    const user = attempts[0]!.userId;
    await t.prisma.referrerCustomerAttempt.createMany({
      data: Array.from({ length: REFERRER_DAILY_REFUSALS - 1 }, () => ({
        partnerId: otherPartner,
        userId: user,
        phoneEnd: '000',
        refused: true,
      })),
    });
    const limited = await as(cookies.other)
      .post('/referrer-portal/customers', { name: 'ZZ new', phone: uniquePhone() })
      .expect(429);
    expect(code(limited.body)).toBe('TOO_MANY_ATTEMPTS');
    // Yesterday's refusals do not count.
    await t.prisma.referrerCustomerAttempt.updateMany({
      where: { partnerId: otherPartner },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });
    await as(cookies.other)
      .post('/referrer-portal/customers', { name: 'ZZ new', phone: uniquePhone() })
      .expect(201);
  });

  it('shows nothing once his broker is inactive', async () => {
    const b = await newBroker('ZZ soon inactive');
    const login = await brokerLogin(b);
    await t.prisma.partner.update({ where: { id: b.id }, data: { isActive: false } });
    const shown = (await as(login.cookie).get('/referrer-portal').expect(200))
      .body as ReferrerPortalDto;
    expect(shown.broker).toBeNull();
    const res = await as(login.cookie)
      .post('/referrer-portal/customers', { name: 'ZZ none', phone: uniquePhone() })
      .expect(409);
    expect(code(res.body)).toBe('NO_BROKER');
  });

  it('gives the role alone, in one branch, for one active broker of that branch', async () => {
    const body = (extra: object) => ({
      email: `it-${randomUUID()}@nolon.test`,
      fullName: 'Broker login',
      password: 'Integration-Test-Password-1',
      preferredLocale: 'ar',
      roles: ['REFERRER_STAFF'],
      branchIds: [jed],
      outletIds: [broker.id],
      ...extra,
    });
    const admin = as(cookies.admin);
    await admin.post('/users', body({ roles: ['REFERRER_STAFF', 'SALES'] })).expect(400);
    await admin.post('/users', body({ outletIds: [] })).expect(400);
    await admin
      .post('/users', body({ branchIds: [jed, await branchId(t.prisma, 'DXB')] }))
      .expect(400);
    const outlet = (
      await as(cookies.manager)
        .post('/partners', {
          kind: 'SALES_OUTLET',
          branchId: jed,
          name: 'ZZ outlet',
          countryCode: 'SA',
          currency: 'SAR',
        })
        .expect(201)
    ).body as PartnerDto;
    await admin.post('/users', body({ outletIds: [outlet.id] })).expect(400);
  });

  it('keeps the team restricted in the database: no added permission, no branch team', async () => {
    const team = await t.prisma.team.findUniqueOrThrow({ where: { systemRole: 'REFERRER_STAFF' } });
    expect(team.restricted).toBe(true);
    const adminId = (await createUser(t.prisma, ['ADMINISTRATOR'])).id;
    await expect(
      t.prisma.teamPermissionChange.create({
        data: {
          teamId: team.id,
          permission: 'customers:view',
          effect: 'ALLOW',
          createdById: adminId,
        },
      }),
    ).rejects.toThrow(/restricted team/);
    await expect(
      t.prisma.team.update({ where: { id: team.id }, data: { restricted: false } }),
    ).rejects.toThrow();
  });
});
