import {
  REFERRAL_CODE_PATTERN,
  type CustomerDto,
  type PartnerChatLinkDto,
  type PartnerDto,
} from '@nolon/shared';
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
  /** The same person's next message. */
  const again = (from: Sender) => ({
    ...from,
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
  });
  const capture = (from: Sender, extra: object = {}) => ({
    schemaVersion: 'nolon.customer-identity/1',
    conversationId: randomUUID(),
    sender: from,
    fields: {},
    ...extra,
  });
  function postCapture(body: { sender: Sender }) {
    return signedPost('/api/v1/cs/customer-profiles/capture', body, body.sender);
  }
  /** Plan 18, 5: the bot binds the account `from` with a broker's private link. */
  const postLink = (token: string, from: Sender) =>
    signedPost('/api/v1/cs/referrers/link', { token, identity: from }, from);
  function signedPost(path: string, body: object, from: Sender) {
    const rawBody = JSON.stringify(body);
    const { channel, subjectId, channelAccountId, eventId, observedAt } = from;
    const rawContext = JSON.stringify({
      channel,
      subjectId,
      channelAccountId,
      eventId,
      observedAt,
    });
    const issued = Math.floor(Date.now() / 1000).toString();
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
        scopes: {
          create: [
            { scope: 'CUSTOMER_PROFILES_WRITE', grantedById: keyOwner.id },
            { scope: 'REFERRERS_LINK', grantedById: keyOwner.id },
          ],
        },
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

    it('keeps the code of a capture with no name and links the file a later message makes (F238-1)', async () => {
      const broker = await newPartner();
      const from = sender();
      const first = (
        await postCapture(capture(from, { referral: { code: broker.referralCode } })).expect(201)
      ).body as IdentityResult;
      expect(await t.prisma.customer.count({ where: { profileId: first.profileId! } })).toBe(0);
      const later = await captured(
        capture(again(from), {
          fields: { name: { value: 'Named Later', source: 'CUSTOMER_STATEMENT' } },
        }),
      );
      expect(later.referredByPartnerId).toBe(broker.id);
      // A code that comes only with a later message, before any file, is ignored too.
      const other = await newPartner();
      const quiet = sender();
      await postCapture(capture(quiet)).expect(201);
      const named = await captured(
        capture(again(quiet), {
          fields: { name: { value: 'Code Too Late', source: 'CUSTOMER_STATEMENT' } },
          referral: { code: other.referralCode },
        }),
      );
      expect(named.referredByPartnerId).toBeNull();
    });

    it('links no one once the broker is inactive when the file is made', async () => {
      const broker = await newPartner();
      const from = sender();
      await postCapture(capture(from, { referral: { code: broker.referralCode } })).expect(201);
      await patch(`/partners/${broker.id}`, cookies.jedManager, { isActive: false }).expect(200);
      const customer = await captured(
        capture(again(from), {
          fields: { name: { value: 'Broker Gone', source: 'CUSTOMER_STATEMENT' } },
        }),
      );
      expect(customer.referredByPartnerId).toBeNull();
    });

    it('links no one when another customer took the profile’s phone before the file (F238-2)', async () => {
      const broker = await newPartner();
      const phone = uniquePhone();
      const from = sender();
      const first = (
        await postCapture(
          capture(from, {
            fields: { phone: { value: phone, source: 'CUSTOMER_STATEMENT' } },
            referral: { code: broker.referralCode },
          }),
        ).expect(201)
      ).body as IdentityResult;
      const profile = await t.prisma.customerProfile.findUniqueOrThrow({
        where: { id: first.profileId! },
      });
      expect(profile).toMatchObject({ phone, referralPartnerId: broker.id });
      await post('/customers', cookies.jedSales, {
        kind: 'INDIVIDUAL',
        name: 'Took The Phone',
        phone,
      }).expect(201);
      const customer = await captured(
        capture(again(from), {
          fields: { name: { value: 'Phone Taken Meanwhile', source: 'CUSTOMER_STATEMENT' } },
        }),
      );
      expect(customer.phone).toBeNull();
      expect(customer.referredByPartnerId).toBeNull();
    });

    it('drops a kept code when a later message brings a phone another customer holds', async () => {
      const broker = await newPartner();
      const phone = uniquePhone();
      await post('/customers', cookies.jedSales, {
        kind: 'INDIVIDUAL',
        name: 'Holds The Phone',
        phone,
      }).expect(201);
      const from = sender();
      await postCapture(capture(from, { referral: { code: broker.referralCode } })).expect(201);
      const customer = await captured(
        capture(again(from), {
          fields: {
            name: { value: 'Known After All', source: 'CUSTOMER_STATEMENT' },
            phone: { value: phone, source: 'CUSTOMER_STATEMENT' },
          },
        }),
      );
      expect(customer.referredByPartnerId).toBeNull();
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

  describe('the broker’s Telegram account (plan 18-3)', () => {
    const issue = async (brokerId: string, cookie = cookies.jedManager) =>
      (await post(`/partners/${brokerId}/chat-link`, cookie).expect(201))
        .body as PartnerChatLinkDto;

    it('links the account that opens the private link, once, for 7 days', async () => {
      const broker = await newPartner({ name: `Ahmed ZZ ${suffix()}` });
      const link = await issue(broker.id);
      expect(link.token).toMatch(/^ag_[A-Za-z0-9]{32}$/);
      const stored = await t.prisma.referrerLinkToken.findFirstOrThrow({
        where: { partnerId: broker.id },
      });
      // Only the hash is kept.
      expect(stored.tokenHash).toBe(sha256(link.token));
      expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
      const phone = sender();
      const res = await postLink(link.token, phone).expect(200);
      expect(res.body).toEqual({
        status: 'LINKED',
        firstName: 'Ahmed',
      });
      // The same account opening it again: still linked, not an error.
      await postLink(link.token, again(phone)).expect(200);
      // Another account: used.
      expect(refusal((await postLink(link.token, sender()).expect(409)).body).code).toBe(
        'REFERRER_LINK_USED',
      );
      const shown = (await get(`/partners/${broker.id}`, cookies.jedManager).expect(200))
        .body as PartnerDto;
      expect(shown.chatLinkedAt).not.toBeNull();
      const binding = await t.prisma.partnerChannelBinding.findFirstOrThrow({
        where: { partnerId: broker.id, revokedAt: null },
      });
      expect(binding).toMatchObject({ channel: 'TELEGRAM', subjectId: phone.subjectId });
    });

    it('refuses an unknown, revoked or expired link, and an account already another broker’s', async () => {
      await postLink(`ag_${'x'.repeat(32)}`, sender()).expect(404);
      await postLink('not-a-token', sender()).expect(404);
      const broker = await newPartner();
      const first = await issue(broker.id);
      // A new link revokes the open one.
      const second = await issue(broker.id);
      expect(refusal((await postLink(first.token, sender()).expect(404)).body).code).toBe(
        'REFERRER_LINK_UNKNOWN',
      );
      await t.prisma.referrerLinkToken.updateMany({
        where: { tokenHash: sha256(second.token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(refusal((await postLink(second.token, sender()).expect(410)).body).code).toBe(
        'REFERRER_LINK_EXPIRED',
      );
      // An account bound to broker A cannot become broker B's.
      const a = await newPartner();
      const b = await newPartner();
      const phone = sender();
      await postLink((await issue(a.id)).token, phone).expect(200);
      await postLink((await issue(b.id)).token, again(phone)).expect(409);
      // An inactive broker's link no longer works.
      const c = await newPartner();
      const cLink = await issue(c.id);
      await patch(`/partners/${c.id}`, cookies.jedManager, { isActive: false }).expect(200);
      await postLink(cLink.token, sender()).expect(404);
    });

    it('replaces the broker’s earlier account, and staff can unlink it', async () => {
      const broker = await newPartner();
      const one = sender();
      const two = sender();
      await postLink((await issue(broker.id)).token, one).expect(200);
      await postLink((await issue(broker.id)).token, two).expect(200);
      const live = await t.prisma.partnerChannelBinding.findMany({
        where: { partnerId: broker.id, revokedAt: null },
      });
      expect(live.map((b) => b.subjectId)).toEqual([two.subjectId]);
      const after = (
        await post(`/partners/${broker.id}/chat-link/revoke`, cookies.jedManager).expect(200)
      ).body as PartnerDto;
      expect(after.chatLinkedAt).toBeNull();
      await post(`/partners/${broker.id}/chat-link/revoke`, cookies.jedManager).expect(409);
      // The unlinked account may now be linked again, to anyone.
      await postLink((await issue(broker.id)).token, again(two)).expect(200);
    });

    it('lets only a manager of the broker’s branch issue links, and only for referrers', async () => {
      const broker = await newPartner();
      await post(`/partners/${broker.id}/chat-link`, cookies.jedSales).expect(403);
      await post(`/partners/${broker.id}/chat-link`, cookies.dxbManager).expect(404);
      const outlet = await newPartner({ kind: 'SALES_OUTLET' });
      expect(
        refusal(
          (await post(`/partners/${outlet.id}/chat-link`, cookies.jedManager).expect(400)).body,
        ).code,
      ).toBe('NOT_A_REFERRER');
    });

    it('keeps one live account per broker and channel, and per chat account, in the database', async () => {
      const broker = await newPartner();
      const phone = sender();
      await postLink((await issue(broker.id)).token, phone).expect(200);
      const live = await t.prisma.partnerChannelBinding.findFirstOrThrow({
        where: { partnerId: broker.id, revokedAt: null },
      });
      await expect(
        t.prisma.partnerChannelBinding.create({
          data: {
            partnerId: broker.id,
            apiClientId: clientId,
            channel: 'TELEGRAM',
            subjectId: 'other',
            livePartnerChannel: live.livePartnerChannel,
            liveSubject: 'TELEGRAM:other',
          },
        }),
      ).rejects.toThrow();
      // A revoked row keeps no live key.
      await expect(
        t.prisma.partnerChannelBinding.update({
          where: { id: live.id },
          data: { revokedAt: new Date() },
        }),
      ).rejects.toThrow();
    });
  });
});
