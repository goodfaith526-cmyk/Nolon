import { REFERRAL_CODE_PATTERN, type CustomerDto, type PartnerDto } from '@nolon/shared';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import type { IdentityResult } from '../src/customer-service/customer-identity.contract.js';
import {
  APP_ORIGIN,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  LEDGER_PREFIX,
  signIn,
} from './auth-test-app.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const suffix = () =>
  Array.from({ length: 5 }, () => LETTERS[randomInt(0, LETTERS.length)] ?? 'Z').join('');

/**
 * Plan 18, build 18-1: the referral broker (partner kind REFERRER), his customer code, the link a
 * bot capture makes for a NEW customer only, and the staff change with a reason.
 */
describe('Referral brokers (plan 18-1)', () => {
  let t: TestApp;
  let jed = '';
  let dxb = '';
  let jeddahPort = '';
  const cookies = { jedManager: '', dxbManager: '', jedSales: '', warehouse: '' };
  const clientId = randomUUID();
  const secret = 'test-channel-assertion-secret-32-characters';
  const key = newApiKey();
  const companyId = `referral-${randomUUID()}`;

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const refusal = (body: unknown) => body as { code?: string; fields?: string[] };

  const partnerBody = (overrides: object = {}) => ({
    kind: 'REFERRER',
    branchId: jed,
    name: `ZZ broker ${suffix()}`,
    phone: uniquePhone(),
    countryCode: 'SA',
    locationId: jeddahPort,
    currency: 'SAR',
    ...overrides,
  });
  const newPartner = async (overrides: object = {}, cookie = cookies.jedManager) =>
    (await post('/partners', cookie, partnerBody(overrides)).expect(201)).body as PartnerDto;

  const sender = (extra: object = {}) => ({
    channel: 'TELEGRAM',
    subjectId: `${Date.now()}${randomInt(0, 100000)}`,
    channelAccountId: 'test-bot',
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    ...extra,
  });
  type Sender = ReturnType<typeof sender>;
  const capture = (from: Sender, extra: object = {}) => ({
    schemaVersion: 'nolon.customer-identity/1',
    conversationId: randomUUID(),
    sender: from,
    fields: {},
    ...extra,
  });
  function postCapture(body: { sender: Sender }) {
    const rawBody = JSON.stringify(body);
    const { channel, subjectId, channelAccountId, eventId, observedAt } = body.sender;
    const rawContext = JSON.stringify({
      channel,
      subjectId,
      channelAccountId,
      eventId,
      observedAt,
    });
    const issued = Math.floor(Date.now() / 1000).toString();
    const path = '/api/v1/cs/customer-profiles/capture';
    const idem = randomUUID();
    const payload = [
      'v1',
      clientId,
      'POST',
      path,
      idem,
      issued,
      sha256(rawContext),
      sha256(rawBody),
    ].join('\n');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return t
      .http()
      .post(path)
      .set('Authorization', `Bearer ${key.key}`)
      .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
      .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'))
      .set('Idempotency-Key', idem)
      .set('Content-Type', 'application/json')
      .send(rawBody);
  }
  const accountOf = async (profileId: string) =>
    t.prisma.customer.findFirstOrThrow({ where: { profileId } });
  const captured = async (body: { sender: Sender }) =>
    accountOf(
      (
        (await postCapture(body).expect((r) => expect([200, 201]).toContain(r.status)))
          .body as IdentityResult
      ).profileId!,
    );

  beforeAll(async () => {
    t = await createTestApp({
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_ACCOUNT_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: companyId,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({
        [clientId]: { secret, accounts: [{ channel: 'TELEGRAM', channelAccountId: 'test-bot' }] },
      }),
    });
    jed = await branchId(t.prisma, 'JED');
    dxb = await branchId(t.prisma, 'DXB');
    jeddahPort = (await t.prisma.location.findUniqueOrThrow({ where: { code: 'SAJED' } })).id;
    const jedManager = await createUser(t.prisma, ['BRANCH_MANAGER'], ['JED']);
    cookies.jedManager = await signIn(t, jedManager.email);
    cookies.dxbManager = await signIn(
      t,
      (await createUser(t.prisma, ['BRANCH_MANAGER'], ['DXB'])).email,
    );
    cookies.jedSales = await signIn(t, (await createUser(t.prisma, ['SALES'], ['JED'])).email);
    cookies.warehouse = await signIn(t, (await createUser(t.prisma, ['WAREHOUSE'], ['JED'])).email);
    // The key's owner is not an `it-` user: the customers its captures make keep the key.
    const keyOwner = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    await t.prisma.apiClient.create({
      data: {
        id: clientId,
        name: 'Referral test',
        keyPrefix: key.prefix,
        keyHash: key.hash,
        createdById: keyOwner.id,
        customersRead: false,
        branches: { create: [{ branchId: jed }] },
        scopes: { create: [{ scope: 'CUSTOMER_PROFILES_WRITE', grantedById: keyOwner.id }] },
      },
    });
  });

  afterAll(async () => {
    await deleteCommercialTestData(t.prisma);
    await deleteTestUsers(t.prisma);
    await t.close();
  });

  describe('the broker and his customer code', () => {
    it('gives a new referrer one live code; other kinds have none', async () => {
      const broker = await newPartner({ referralWindowDays: 180 });
      expect(broker).toMatchObject({
        kind: 'REFERRER',
        referralWindowDays: 180,
        actions: { canEdit: true, canIssueReferralCode: true },
      });
      expect(broker.referralCode).toMatch(REFERRAL_CODE_PATTERN);
      expect(
        await t.prisma.referralCode.count({ where: { partnerId: broker.id, retiredAt: null } }),
      ).toBe(1);
      const outlet = await newPartner({ kind: 'SALES_OUTLET' });
      expect(outlet.referralCode).toBeNull();
      expect(outlet.actions.canIssueReferralCode).toBe(false);
      // Sales read the broker but cannot issue codes.
      const read = (await get(`/partners/${broker.id}`, cookies.jedSales).expect(200))
        .body as PartnerDto;
      expect(read.actions.canIssueReferralCode).toBe(false);
    });

    it('keeps the expiry for referrers only, within its bounds', async () => {
      const res = await post(
        '/partners',
        cookies.jedManager,
        partnerBody({ kind: 'SALES_OUTLET', referralWindowDays: 30 }),
      ).expect(400);
      expect(refusal(res.body)).toMatchObject({
        code: 'NOT_A_REFERRER',
        fields: ['referralWindowDays'],
      });
      await post('/partners', cookies.jedManager, partnerBody({ referralWindowDays: 0 })).expect(
        400,
      );
      await post('/partners', cookies.jedManager, partnerBody({ referralWindowDays: 3651 })).expect(
        400,
      );
      const broker = await newPartner();
      expect(broker.referralWindowDays).toBeNull();
      const updated = (
        await patch(`/partners/${broker.id}`, cookies.jedManager, {
          referralWindowDays: 90,
        }).expect(200)
      ).body as PartnerDto;
      expect(updated.referralWindowDays).toBe(90);
      const outlet = await newPartner({ kind: 'SALES_OUTLET' });
      await patch(`/partners/${outlet.id}`, cookies.jedManager, {
        referralWindowDays: 90,
      }).expect(400);
    });

    it('never turns a referrer into another kind, nor another kind into a referrer', async () => {
      const broker = await newPartner();
      const outlet = await newPartner({ kind: 'SALES_OUTLET' });
      for (const [id, kind] of [
        [broker.id, 'SALES_OUTLET'],
        [outlet.id, 'REFERRER'],
      ] as const) {
        const res = await patch(`/partners/${id}`, cookies.jedManager, { kind }).expect(400);
        expect(refusal(res.body)).toMatchObject({ code: 'REFERRER_KIND_FIXED', fields: ['kind'] });
      }
    });

    it('keeps one live code per broker in the database itself', async () => {
      const broker = await newPartner();
      const insert = (code: string, live: string | null, retired: boolean) =>
        t.prisma.$executeRaw`
          INSERT INTO "referral_codes" ("code", "partner_id", "live_partner_id", "retired_at")
          VALUES (${code}, ${broker.id}::uuid, ${live}::uuid, ${retired ? new Date() : null})`;
      // A second live code, a live code with no live mark, a retired one still marked, a bad code.
      await expect(insert('r_zz000001', broker.id, false)).rejects.toThrow();
      await expect(insert('r_zz000002', null, false)).rejects.toThrow();
      await expect(insert('r_zz000003', broker.id, true)).rejects.toThrow();
      await expect(insert('R_BAD', null, true)).rejects.toThrow();
      await insert(`r_${suffix().toLowerCase()}zzz`, null, true);
    });

    it('issues a new code and retires the old one, audited; refused elsewhere', async () => {
      const broker = await newPartner();
      const renewed = (
        await post(`/partners/${broker.id}/referral-code`, cookies.jedManager).expect(201)
      ).body as PartnerDto;
      expect(renewed.referralCode).toMatch(REFERRAL_CODE_PATTERN);
      expect(renewed.referralCode).not.toBe(broker.referralCode);
      const old = await t.prisma.referralCode.findUniqueOrThrow({
        where: { code: broker.referralCode! },
      });
      expect(old.retiredAt).not.toBeNull();
      const audit = await t.prisma.auditEvent.findMany({
        where: { entityId: broker.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(JSON.stringify(audit.at(-1)?.changes)).toContain('referralCode');
      // Another branch's manager does not see it; Sales may not; an outlet has no code.
      await post(`/partners/${broker.id}/referral-code`, cookies.dxbManager).expect(404);
      await post(`/partners/${broker.id}/referral-code`, cookies.jedSales).expect(403);
      const outlet = await newPartner({ kind: 'SALES_OUTLET' });
      const res = await post(`/partners/${outlet.id}/referral-code`, cookies.jedManager).expect(
        400,
      );
      expect(refusal(res.body).code).toBe('NOT_A_REFERRER');
    });
  });

  describe('a bot capture with the code', () => {
    it('links the new customer it makes to the broker, audited', async () => {
      const broker = await newPartner();
      const customer = await captured(
        capture(sender({ displayName: 'Referred Person' }), {
          referral: { code: broker.referralCode },
        }),
      );
      expect(customer.referredByPartnerId).toBe(broker.id);
      expect(customer.referredAt).not.toBeNull();
      const audit = await t.prisma.auditEvent.findFirstOrThrow({
        where: { entityId: customer.id },
      });
      expect(JSON.stringify(audit.changes)).toContain(broker.id);
      const dto = (await get(`/customers/${customer.id}`, cookies.jedManager).expect(200))
        .body as CustomerDto;
      expect(dto.referredBy).toMatchObject({ id: broker.id, number: broker.number });
    });

    it('ignores a code on a later message of someone already known', async () => {
      const broker = await newPartner();
      const from = sender({ displayName: 'Known Person' });
      const first = await captured(capture(from));
      expect(first.referredByPartnerId).toBeNull();
      const again = await captured(
        capture(
          { ...from, eventId: randomUUID(), observedAt: new Date().toISOString() },
          { referral: { code: broker.referralCode } },
        ),
      );
      expect(again.id).toBe(first.id);
      expect(again.referredByPartnerId).toBeNull();
    });

    it('ignores a retired code, an inactive broker, an unknown or malformed code', async () => {
      const retired = await newPartner();
      await post(`/partners/${retired.id}/referral-code`, cookies.jedManager).expect(201);
      const inactive = await newPartner();
      await patch(`/partners/${inactive.id}`, cookies.jedManager, { isActive: false }).expect(200);
      for (const code of [
        retired.referralCode!,
        inactive.referralCode!,
        'r_zzzzzzzz',
        'R_NOTVALID',
      ]) {
        const customer = await captured(
          capture(sender({ displayName: 'Not Linked' }), { referral: { code } }),
        );
        expect(customer.referredByPartnerId).toBeNull();
      }
    });

    it('links no one whose typed phone another customer already holds', async () => {
      const broker = await newPartner();
      const phone = uniquePhone();
      await post('/customers', cookies.jedSales, {
        kind: 'INDIVIDUAL',
        name: 'Phone Holder',
        phone,
      }).expect(201);
      const customer = await captured(
        capture(sender({ displayName: 'Same Phone' }), {
          fields: { phone: { value: phone, source: 'CUSTOMER_STATEMENT' } },
          referral: { code: broker.referralCode },
        }),
      );
      expect(customer.phone).toBeNull();
      expect(customer.referredByPartnerId).toBeNull();
    });
  });

  describe('staff set, change or clear the broker', () => {
    const newCustomer = async () =>
      (
        await post('/customers', cookies.jedSales, {
          kind: 'INDIVIDUAL',
          name: `ZZ Customer ${suffix()}`,
          phone: uniquePhone(),
        }).expect(201)
      ).body as CustomerDto;
    const setReferrer = (id: string, body: object, cookie = cookies.jedManager) =>
      post(`/customers/${id}/referrer`, cookie, body);

    it('sets, changes (restarting the window) and clears, each with its reason', async () => {
      const [a, b] = [await newPartner(), await newPartner()];
      const customer = await newCustomer();
      expect(customer.referredBy).toBeNull();
      const set = (
        await setReferrer(customer.id, { partnerId: a.id, reason: 'He brought them' }).expect(200)
      ).body as CustomerDto;
      expect(set.referredBy?.id).toBe(a.id);
      expect(set.referredAt).not.toBeNull();
      const changed = (
        await setReferrer(customer.id, { partnerId: b.id, reason: 'Wrong broker' }).expect(200)
      ).body as CustomerDto;
      expect(changed.referredBy?.id).toBe(b.id);
      expect(new Date(changed.referredAt!).getTime()).toBeGreaterThan(
        new Date(set.referredAt!).getTime(),
      );
      // The same broker again changes nothing (no new window, no audit line).
      const before = await t.prisma.auditEvent.count({ where: { entityId: customer.id } });
      const same = (
        await setReferrer(customer.id, { partnerId: b.id, reason: 'Again' }).expect(200)
      ).body as CustomerDto;
      expect(same.referredAt).toBe(changed.referredAt);
      expect(await t.prisma.auditEvent.count({ where: { entityId: customer.id } })).toBe(before);
      const cleared = (
        await setReferrer(customer.id, { partnerId: null, reason: 'Not a referral' }).expect(200)
      ).body as CustomerDto;
      expect(cleared.referredBy).toBeNull();
      expect(cleared.referredAt).toBeNull();
      const audit = await t.prisma.auditEvent.findMany({ where: { entityId: customer.id } });
      const text = JSON.stringify(audit.map((e) => e.changes));
      for (const reason of ['He brought them', 'Wrong broker', 'Not a referral']) {
        expect(text).toContain(reason);
      }
    });

    it('refuses another kind, another branch’s or an inactive broker, and no reason', async () => {
      const customer = await newCustomer();
      const outlet = await newPartner({ kind: 'SALES_OUTLET' });
      const dxbBroker = await newPartner({ branchId: dxb }, cookies.dxbManager);
      const inactive = await newPartner();
      await patch(`/partners/${inactive.id}`, cookies.jedManager, { isActive: false }).expect(200);
      for (const id of [outlet.id, dxbBroker.id, inactive.id, randomUUID()]) {
        const res = await setReferrer(customer.id, { partnerId: id, reason: 'x' }).expect(400);
        expect(refusal(res.body)).toMatchObject({
          code: 'PARTNER_NOT_USABLE',
          fields: ['partnerId'],
        });
      }
      const broker = await newPartner();
      await setReferrer(customer.id, { partnerId: broker.id, reason: '' }).expect(400);
      await setReferrer(customer.id, { partnerId: broker.id }).expect(400);
      expect(
        (await t.prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }))
          .referredByPartnerId,
      ).toBeNull();
    });

    it('needs customers:update', async () => {
      const customer = await newCustomer();
      const broker = await newPartner();
      await setReferrer(
        customer.id,
        { partnerId: broker.id, reason: 'x' },
        cookies.warehouse,
      ).expect(403);
    });
  });
});
