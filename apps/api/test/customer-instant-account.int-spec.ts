import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import type { IdentityResult } from '../src/customer-service/customer-identity.contract.js';
import { CustomersService } from '../src/customers/customers.service.js';
import {
  APP_ORIGIN,
  branchId,
  createTestApp,
  createUser,
  LEDGER_PREFIX,
  signIn,
  type TestApp,
} from './auth-test-app.js';
import { uniquePhone } from './test-data.js';

/**
 * The owner's instant account (2026-11-03): a signed bot request for a known branch makes or reuses
 * the unified profile's branch account in the same transaction, with approval's checks; anything
 * not ready leaves a reason for staff and the old flow. The ten acceptance cases of the spec.
 */
describe('Instant branch account from a signed bot booking request', () => {
  let t: TestApp;
  let off: TestApp;
  let dxb = '';
  let jed = '';
  let staffCookie = '';
  const originDxb = randomUUID();
  const originJed = randomUUID();
  const originBoth = randomUUID();
  const destinationId = randomUUID();
  const category = `N${randomUUID().slice(0, 6).toUpperCase()}`;
  const clientId = randomUUID();
  const otherId = randomUUID();
  const secret = 'test-channel-assertion-secret-32-characters';
  const key = newApiKey();
  const otherKey = newApiKey();
  const companyId = `instant-${randomUUID()}`;

  type Sender = {
    channel: string;
    subjectId: string;
    channelAccountId: string;
    eventId: string;
    observedAt: string;
  };
  const sender = (): Sender => ({
    channel: 'TELEGRAM',
    subjectId: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
    channelAccountId: 'test-bot',
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
  });

  /** A signed call as the bot makes it (plan 08 channel assertion). */
  function call(
    app: TestApp,
    path: string,
    body: object,
    who: Sender,
    opts: { idem?: string; client?: string; token?: string; issued?: number } = {},
  ) {
    const idem = opts.idem ?? randomUUID();
    const client = opts.client ?? clientId;
    const rawBody = JSON.stringify(body);
    const rawContext = JSON.stringify({
      channel: who.channel,
      subjectId: who.subjectId,
      channelAccountId: who.channelAccountId,
      eventId: who.eventId,
      observedAt: who.observedAt,
    });
    const issued = (opts.issued ?? Math.floor(Date.now() / 1000)).toString();
    const fullPath = `/api/v1${path}`;
    const payload = [
      'v1',
      client,
      'POST',
      fullPath,
      idem,
      issued,
      sha256(rawContext),
      sha256(rawBody),
    ].join('\n');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return app
      .http()
      .post(fullPath)
      .set('Authorization', `Bearer ${opts.token ?? key.key}`)
      .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
      .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'))
      .set('Idempotency-Key', idem)
      .set('Content-Type', 'application/json')
      .send(rawBody);
  }

  /** A captured profile, with an explicit name unless told otherwise. */
  async function profile(app: TestApp, name: string | null = 'Instant sender') {
    const who = sender();
    const conversationId = randomUUID();
    const res = await call(
      app,
      '/cs/customer-profiles/capture',
      {
        schemaVersion: 'nolon.customer-identity/1',
        conversationId,
        sender: who,
        fields: name ? { name: { value: name, source: 'CUSTOMER_STATEMENT' } } : {},
      },
      who,
    ).expect(201);
    const r = res.body as IdentityResult;
    if (r.profileId === null || r.profileVersion === null) throw new Error('No profile captured');
    return { who, conversationId, profileId: r.profileId, profileVersion: r.profileVersion };
  }

  type Profile = Awaited<ReturnType<typeof profile>>;
  const body = (p: Profile, extra: object = {}) => ({
    idempotencyKey: randomUUID(),
    profileId: p.profileId,
    conversationId: p.conversationId,
    sender: { channel: 'telegram', id: p.who.subjectId },
    originId: originDxb,
    destinationId,
    category,
    quantity: '2',
    services: [],
    senderName: 'Instant sender',
    consigneeName: 'Receiver',
    consigneePhone: '0912345678',
    handover: 'BRANCH_DROP',
    language: 'ar',
    ...extra,
  });
  const book = (app: TestApp, p: Profile, b: ReturnType<typeof body>, opts = {}) =>
    call(app, '/cs/booking-requests', b, p.who, { idem: b.idempotencyKey, ...opts });
  const requestOf = async (res: { body: unknown }) =>
    t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: (res.body as { requestId: string }).requestId },
    });
  const accountsOf = (profileId: string) =>
    t.prisma.customer.findMany({ where: { profileId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    const config = {
      secret,
      accounts: [{ channel: 'TELEGRAM', channelAccountId: 'test-bot' }],
    };
    const env = {
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_BOOKING_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: companyId,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({ [clientId]: config, [otherId]: config }),
    };
    t = await createTestApp({ ...env, CS_INSTANT_CUSTOMER_ENABLED: true });
    off = await createTestApp(env);
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    const sales = await createUser(t.prisma, ['SALES'], ['DXB', 'JED'], LEDGER_PREFIX);
    staffCookie = await signIn(t, sales.email);
    await t.prisma.currency.upsert({
      where: { code: 'USD' },
      create: { code: 'USD', nameEn: 'US Dollar', nameAr: 'دولار', decimalPlaces: 2 },
      update: {},
    });
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    for (const [id, suffix] of [
      [originDxb, 'A'],
      [originJed, 'B'],
      [originBoth, 'C'],
      [destinationId, 'D'],
    ] as const) {
      await t.prisma.location.create({
        data: {
          id,
          code: `${category}${suffix}`,
          nameEn: `${category}${suffix}`,
          nameAr: 'مدينة اختبار',
          kind: 'CITY',
          countryCode: 'AE',
        },
      });
    }
    await t.prisma.branchRoutingRule.createMany({
      data: [
        { locationId: originDxb, branchId: dxb },
        { locationId: originJed, branchId: jed },
        { locationId: originBoth, branchId: dxb },
        { locationId: originBoth, branchId: jed },
      ],
    });
    for (const [id, k] of [
      [clientId, key],
      [otherId, otherKey],
    ] as const) {
      await t.prisma.apiClient.create({
        data: {
          id,
          name: 'Instant account test',
          keyPrefix: k.prefix,
          keyHash: k.hash,
          createdById: admin.id,
          customersRead: false,
          branches: { create: [{ branchId: dxb }, { branchId: jed }] },
          scopes: {
            create: [
              { scope: 'CUSTOMER_PROFILES_WRITE', grantedById: admin.id },
              { scope: 'BOOKING_REQUESTS_CREATE', grantedById: admin.id },
            ],
          },
        },
      });
    }
  });

  afterAll(async () => {
    await t?.close();
    await off?.close();
  });

  it('makes the account once, an individual with no terms, audited without its texts (1, 10)', async () => {
    const p = await profile(t);
    const unverified = uniquePhone();
    await t.prisma.customerProfile.update({
      where: { id: p.profileId },
      data: { phone: unverified, phoneVerified: false },
    });
    const res = await book(t, p, body(p)).expect(201);
    const row = await requestOf(res);
    expect(row.status).toBe('PENDING');
    const accounts = await accountsOf(p.profileId);
    expect(accounts).toHaveLength(1);
    const account = accounts[0]!;
    expect(row).toMatchObject({ instantAccount: 'CREATED', instantCustomerId: account.id });
    expect(account).toMatchObject({
      kind: 'INDIVIDUAL',
      name: 'Instant sender',
      // 10 (owner, 2026-11-05): a typed phone is copied too, marked unverified.
      phone: unverified,
      phoneUnverified: true,
      creditLimit: null,
      creditLimitCurrency: null,
      paymentTermsDays: 0,
      createdById: null,
      createdViaApiClientId: clientId,
      acquiredViaOutletId: null,
    });
    const audit = await t.prisma.auditEvent.findMany({
      where: { entity: 'CUSTOMER', entityId: account.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ source: 'API', userId: null, action: 'CREATED' });
    const logged = JSON.stringify([audit[0]?.reference, audit[0]?.changes]);
    expect(logged).not.toContain('Instant sender');
    expect(logged).not.toContain(unverified);

    // Staff see it on the request, and approval books for that same account.
    const detail = await t
      .http()
      .get(`/api/v1/cs-booking-requests/${row.id}`)
      .set('Cookie', staffCookie)
      .expect(200);
    const staff = detail.body as {
      version: number;
      instantAccount: unknown;
      profile: { version: number };
    };
    expect(staff.instantAccount).toEqual({ outcome: 'CREATED', customerId: account.id });
    const pricing = {
      originId: originDxb,
      destinationId,
      mode: 'ROAD',
      category,
      quantity: '2',
      currency: 'USD',
    };
    const price = await t
      .http()
      .get(`/api/v1/cs-booking-requests/${row.id}/price`)
      .query(pricing)
      .set('Cookie', staffCookie)
      .expect(200);
    await t
      .http()
      .post(`/api/v1/cs-booking-requests/${row.id}/approve`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', staffCookie)
      .send({
        version: staff.version,
        profileVersion: staff.profile.version,
        pricing,
        pricingFingerprint: (price.body as { pricingFingerprint: string | null })
          .pricingFingerprint,
        paymentCurrency: 'USD',
        booking: { services: [] },
      })
      .expect(201);
    const approved = await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id: row.id } });
    const booking = await t.prisma.booking.findUniqueOrThrow({
      where: { id: approved.bookingId! },
    });
    expect(booking.customerId).toBe(account.id);
    expect(await accountsOf(p.profileId)).toHaveLength(1);
  });

  it('copies a verified phone, and never takes a phone another account of the branch has (10)', async () => {
    const p = await profile(t);
    const phone = uniquePhone();
    await t.prisma.customerProfile.update({
      where: { id: p.profileId },
      data: { phone, phoneVerified: true },
    });
    await book(t, p, body(p)).expect(201);
    expect((await accountsOf(p.profileId))[0]?.phone).toBe(phone);

    const q = await profile(t);
    await t.prisma.customerProfile.update({
      where: { id: q.profileId },
      data: { phone, phoneVerified: true },
    });
    const row = await requestOf(await book(t, q, body(q)).expect(201));
    expect(row).toMatchObject({ instantAccount: 'PHONE_IN_USE', instantCustomerId: null });
    expect(await accountsOf(q.profileId)).toHaveLength(0);
  });

  it('a typed phone in another file never keeps a verified owner from it (Codex F220-1)', async () => {
    const phone = uniquePhone();
    const squatter = await profile(t);
    await t.prisma.customerProfile.update({
      where: { id: squatter.profileId },
      data: { phone, phoneVerified: false },
    });
    await book(t, squatter, body(squatter)).expect(201);
    expect(await accountsOf(squatter.profileId)).toMatchObject([{ phone, phoneUnverified: true }]);

    const owner = await profile(t);
    await t.prisma.customerProfile.update({
      where: { id: owner.profileId },
      data: { phone, phoneVerified: true },
    });
    const row = await requestOf(await book(t, owner, body(owner)).expect(201));
    const [account] = await accountsOf(owner.profileId);
    expect(row).toMatchObject({ instantAccount: 'CREATED', instantCustomerId: account!.id });
    expect(account).toMatchObject({ phone, phoneUnverified: false });
  });

  it('a replay makes no second account (2)', async () => {
    const p = await profile(t);
    const b = body(p);
    const first = await book(t, p, b).expect(201);
    const again = await book(t, p, b).expect(200);
    expect((again.body as { requestId: string }).requestId).toBe(
      (first.body as { requestId: string }).requestId,
    );
    expect(await accountsOf(p.profileId)).toHaveLength(1);
  });

  it('reuses the one account of the profile from any branch (3, plan 09d)', async () => {
    const p = await profile(t);
    const first = await requestOf(await book(t, p, body(p)).expect(201));
    const second = await requestOf(await book(t, p, body(p)).expect(201));
    expect(second).toMatchObject({
      instantAccount: 'REUSED',
      instantCustomerId: first.instantCustomerId,
    });
    // A request of another branch uses the same customer: no account per branch.
    const third = await requestOf(await book(t, p, body(p, { originId: originJed })).expect(201));
    expect(third).toMatchObject({
      instantAccount: 'REUSED',
      instantCustomerId: first.instantCustomerId,
    });
    const accounts = await accountsOf(p.profileId);
    expect(accounts).toHaveLength(1);
    void jed;

    // An inactive account is never revived by the bot: staff decide.
    await t.prisma.customer.update({
      where: { id: first.instantCustomerId! },
      data: { isActive: false },
    });
    const fourth = await requestOf(await book(t, p, body(p)).expect(201));
    expect(fourth).toMatchObject({ instantAccount: 'ACCOUNT_INACTIVE', instantCustomerId: null });
  });

  it('a profile with chat warnings still gets its account (4)', async () => {
    // Owner, 2026-11-07: warnings are staff's to look at, never a reason to make no customer.
    const p = await profile(t);
    await t.prisma.customerProfile.update({
      where: { id: p.profileId },
      data: { needsReview: true },
    });
    const row = await requestOf(await book(t, p, body(p)).expect(201));
    expect(row).toMatchObject({ status: 'PENDING', instantAccount: 'CREATED' });
    expect(await accountsOf(p.profileId)).toHaveLength(1);
    // Staff see the warning and approve: it never blocks.
    const detail = await t
      .http()
      .get(`/api/v1/cs-booking-requests/${row.id}`)
      .set('Cookie', staffCookie)
      .expect(200);
    const staff = detail.body as {
      version: number;
      profile: { version: number; needsReview: boolean; nameDiffersFromSender: boolean };
    };
    expect(staff.profile).toMatchObject({ needsReview: true });
    expect(typeof staff.profile.nameDiffersFromSender).toBe('boolean');
    const pricing = {
      originId: originDxb,
      destinationId,
      mode: 'ROAD',
      category,
      quantity: '2',
      currency: 'USD',
    };
    const price = await t
      .http()
      .get(`/api/v1/cs-booking-requests/${row.id}/price`)
      .query(pricing)
      .set('Cookie', staffCookie)
      .expect(200);
    await t
      .http()
      .post(`/api/v1/cs-booking-requests/${row.id}/approve`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', staffCookie)
      .send({
        version: staff.version,
        profileVersion: staff.profile.version,
        pricing,
        pricingFingerprint: (price.body as { pricingFingerprint: string | null })
          .pricingFingerprint,
        paymentCurrency: 'USD',
        booking: { services: [] },
      })
      .expect(201);
  });

  it('a profile without an explicit name gets no account (5)', async () => {
    const p = await profile(t, null);
    const row = await requestOf(await book(t, p, body(p)).expect(201));
    expect(row).toMatchObject({ instantAccount: 'NAME_MISSING', instantCustomerId: null });
    expect(await accountsOf(p.profileId)).toHaveLength(0);
  });

  it('an unsigned request, or one awaiting routing, keeps the old flow (6)', async () => {
    const p = await profile(t);
    const unsigned = {
      ...body(p),
      profileId: undefined,
      conversationId: undefined,
    };
    const plain = await t
      .http()
      .post('/api/v1/cs/booking-requests')
      .set('Authorization', `Bearer ${key.key}`)
      .send(unsigned)
      .expect(201);
    expect(await requestOf(plain)).toMatchObject({ instantAccount: null, profileId: null });

    const routing = await requestOf(
      await book(t, p, body(p, { originId: originBoth })).expect(201),
    );
    expect(routing).toMatchObject({
      status: 'AWAITING_ROUTING',
      instantAccount: null,
      instantCustomerId: null,
    });
    expect(await accountsOf(p.profileId)).toHaveLength(0);
  });

  it('an expired signature, another key, another company or a stale version makes none (7)', async () => {
    const p = await profile(t);
    const before = await t.prisma.csBookingRequest.count();
    await book(t, p, body(p), { issued: Math.floor(Date.now() / 1000) - 3600 }).expect(401);
    // Another key signing for this key's conversation: the conversation is not its own.
    await book(t, p, body(p), { client: otherId, token: otherKey.key }).expect(404);
    // A profile of another company is never bound.
    const foreign = await t.prisma.customerProfile.create({
      data: { companyId: `other-${randomUUID()}`, number: `X-${randomUUID()}`, name: 'Other' },
    });
    await book(t, p, body(p, { profileId: foreign.id })).expect(404);
    expect(await t.prisma.csBookingRequest.count()).toBe(before);
    expect(await accountsOf(p.profileId)).toHaveLength(0);
    expect(await accountsOf(foreign.id)).toHaveLength(0);

    const stale = await requestOf(
      await book(t, p, body(p, { profileVersion: p.profileVersion + 5 })).expect(201),
    );
    expect(stale).toMatchObject({ instantAccount: 'PROFILE_CHANGED', instantCustomerId: null });
    expect(await accountsOf(p.profileId)).toHaveLength(0);
    const fresh = await requestOf(
      await book(t, p, body(p, { profileVersion: p.profileVersion })).expect(201),
    );
    expect(fresh.instantAccount).toBe('CREATED');
  });

  it('is all or nothing with the request (8)', async () => {
    const p = await profile(t);
    const customers = t.app.get(CustomersService);
    const original = customers.botAccountInTx.bind(customers);
    const spy = vi.spyOn(customers, 'botAccountInTx').mockImplementation(async (...args) => {
      await original(...args);
      throw new Error('fails after the account');
    });
    const b = body(p);
    try {
      await book(t, p, b).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await accountsOf(p.profileId)).toHaveLength(0);
    expect(
      await t.prisma.csBookingRequest.count({ where: { idempotencyKey: b.idempotencyKey } }),
    ).toBe(0);
    // The same request again, now whole.
    await book(t, p, b).expect(201);
    expect(await accountsOf(p.profileId)).toHaveLength(1);
  });

  it('switched off, nothing changes (9)', async () => {
    const p = await profile(off);
    const row = await requestOf(await book(off, p, body(p)).expect(201));
    expect(row).toMatchObject({
      status: 'PENDING',
      profileId: p.profileId,
      instantAccount: null,
      instantCustomerId: null,
    });
    expect(await accountsOf(p.profileId)).toHaveLength(0);
  });
});
