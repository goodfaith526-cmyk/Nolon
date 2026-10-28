import { randomInt } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  BookingDto,
  CsCustomerTokenAnswer,
  CsShipmentDto,
  CsShipmentSummaryDto,
  CsScope,
  CustomerDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';
import { uniquePhone } from './test-data.js';

type TokenAnswer = Extract<CsCustomerTokenAnswer, { kind: 'token' }>;

/** Customer tokens and the reads with them (docs/plans/04 section 3, N1, N2, N4, N5). */
describe('Customer tokens (N1/N2)', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  const cookies = { admin: '', salesPts: '', salesJed: '' };
  const tag = String(randomInt(100_000, 999_999));
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const put = (path: string, cookie: string, body: object) =>
    t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const issue = (key: string, body: object) =>
    t.http().post('/api/v1/cs/customer-tokens').set('Authorization', `Bearer ${key}`).send(body);
  const me = (path: string, token: string) =>
    t.http().get(`/api/v1/cs/me${path}`).set('Authorization', `Bearer ${token}`);

  async function makeKey(branchIds: string[], scopes: CsScope[]): Promise<ApiClientCreatedDto> {
    return (
      await post('/api-clients', cookies.admin, {
        name: `Bot ${tag} ${scopes.join(' ')}`,
        branchIds,
        scopes,
      }).expect(201)
    ).body as ApiClientCreatedDto;
  }

  async function makeCustomer(
    cookie: string,
    branch: string,
    fields: { phone: string; whatsapp?: string; name: string; companyName?: string },
  ): Promise<CustomerDto> {
    return (
      await post('/customers', cookie, {
        branchId: branch,
        kind: fields.companyName ? 'COMPANY' : 'INDIVIDUAL',
        preferredCurrency: 'USD',
        ...fields,
      }).expect(201)
    ).body as CustomerDto;
  }

  async function token(key: string, phone: string, customerNumber?: string): Promise<TokenAnswer> {
    const answer = (
      await issue(key, { phone, ...(customerNumber ? { customerNumber } : {}) }).expect(200)
    ).body as CsCustomerTokenAnswer;
    if (answer.kind !== 'token') throw new Error(`Expected a token, got ${answer.kind}`);
    return answer;
  }

  async function shipmentFor(customer: CustomerDto): Promise<string> {
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: await loc('SDPZU'),
        destinationLocationId: await loc('SDKRT'),
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    const shipment = await t.prisma.shipment.findUniqueOrThrow({
      where: { id: confirmed.shipmentId ?? '' },
    });
    return shipment.number;
  }

  let bot: ApiClientCreatedDto;
  let readKey: ApiClientCreatedDto;
  let jedBot: ApiClientCreatedDto;
  let alpha: CustomerDto;
  let beta: CustomerDto;
  let alphaShipment = '';
  let betaShipment = '';
  const alphaPhone = uniquePhone();
  const alphaWhatsapp = uniquePhone();
  const betaPhone = uniquePhone();
  const sharedPhone = uniquePhone();
  const silentPhone = uniquePhone();

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    // Customers with tokens and access events are kept (the log is append-only): LEDGER_PREFIX.
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    bot = await makeKey([pts], ['cs:customer_tokens:issue']);
    readKey = await makeKey([pts], ['cs:customers:read']);
    jedBot = await makeKey([jed], ['cs:customer_tokens:issue']);

    alpha = await makeCustomer(cookies.salesPts, pts, {
      phone: alphaPhone,
      whatsapp: alphaWhatsapp,
      name: `Alpha ${tag}`,
      companyName: `Alpha Trading ${tag}`,
    });
    beta = await makeCustomer(cookies.salesPts, pts, { phone: betaPhone, name: `Beta ${tag}` });
    // One person may inquire for both: a phone of two customers in the same branch.
    for (const c of [alpha, beta]) {
      await post(`/customers/${c.id}/contacts`, cookies.salesPts, {
        name: 'Shared Contact',
        phone: sharedPhone,
        canInquire: true,
      }).expect(201);
    }
    // An authorized person who may not inquire.
    await post(`/customers/${beta.id}/contacts`, cookies.salesPts, {
      name: 'Receiver Only',
      phone: silentPhone,
      canInquire: false,
      canReceiveCargo: true,
    }).expect(201);
    alphaShipment = await shipmentFor(alpha);
    betaShipment = await shipmentFor(beta);
  });

  afterAll(async () => {
    await t.close();
  });

  it('issues tokens only to a key holding the scope', async () => {
    const refused = await issue(readKey.key, { phone: alphaPhone }).expect(403);
    expect(refused.body).toMatchObject({ code: 'SCOPE_REQUIRED' });
    await issue('nolcs_000000000000_' + 'x'.repeat(43), { phone: alphaPhone }).expect(401);
    // And the bot's key reads no customer by itself.
    await t
      .http()
      .get(`/api/v1/cs/customers/${alpha.number}`)
      .set('Authorization', `Bearer ${bot.key}`)
      .expect(403);
  });

  it('matches the customer phone, WhatsApp or an inquiring contact, and nothing else', async () => {
    const byPhone = await token(bot.key, alphaPhone);
    expect(byPhone).toMatchObject({
      level: 'L1',
      customer: { number: alpha.number, label: `Alpha Trading ${tag}` },
    });
    expect(byPhone.token).toMatch(/^nolct_[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(byPhone.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(Number.isInteger(byPhone.grantVersion)).toBe(true);

    const byWhatsapp = await token(bot.key, alphaWhatsapp);
    expect(byWhatsapp.customer.number).toBe(alpha.number);
    expect(byWhatsapp.grantId).not.toBe(byPhone.grantId);
    // The same reason gives the same grant id.
    expect((await token(bot.key, alphaPhone)).grantId).toBe(byPhone.grantId);

    for (const phone of [uniquePhone(), silentPhone]) {
      expect((await issue(bot.key, { phone }).expect(200)).body).toEqual({ kind: 'none' });
    }
    // A customer of another branch than the key's: not matched.
    expect((await issue(jedBot.key, { phone: alphaPhone }).expect(200)).body).toEqual({
      kind: 'none',
    });
    // Only a verified +E.164 number, and no unknown field.
    await issue(bot.key, { phone: '0912345678' }).expect(400);
    await issue(bot.key, { phone: alphaPhone, customerId: alpha.id }).expect(400);
  });

  it('asks to choose when a phone matches two customers, then binds to the chosen one', async () => {
    const answer = (await issue(bot.key, { phone: sharedPhone }).expect(200))
      .body as CsCustomerTokenAnswer;
    expect(answer.kind).toBe('choose');
    const listed = answer.kind === 'choose' ? answer.customers : [];
    expect(listed.map((c) => c.number).sort()).toEqual([alpha.number, beta.number].sort());
    expect(JSON.stringify(listed)).not.toContain(sharedPhone);

    const chosen = await token(bot.key, sharedPhone, beta.number);
    expect(chosen.customer.number).toBe(beta.number);
    const mine = (await me('/shipments?state=all', chosen.token).expect(200))
      .body as CsShipmentSummaryDto[];
    expect(mine.map((s) => s.number)).toEqual([betaShipment]);
    // A number the phone does not match is no choice.
    const other = await makeCustomer(cookies.salesPts, pts, {
      phone: uniquePhone(),
      name: `Gamma ${tag}`,
    });
    expect(
      (await issue(bot.key, { phone: sharedPhone, customerNumber: other.number }).expect(200)).body,
    ).toEqual({ kind: 'none' });
  });

  it("reads only the token's customer, by new or old shipment numbers", async () => {
    const { token: alphaToken } = await token(bot.key, alphaPhone);
    const shipment = (await me(`/shipments/${alphaShipment}`, alphaToken).expect(200))
      .body as CsShipmentDto;
    expect(shipment.customerNumber).toBe(alpha.number);
    await me(`/shipments/${alphaShipment.toLowerCase()}`, alphaToken).expect(200);
    // Another customer's shipment is not found, as one that does not exist.
    await me(`/shipments/${betaShipment}`, alphaToken).expect(404);
    await me('/shipments/BK99999999', alphaToken).expect(404);

    // Older numbers (NOL-SHP-...), also written without NOL-: resolved among the customer's own.
    const year = new Date().getFullYear();
    const old = `NOL-SHP-${year}-${String(randomInt(100_000, 999_999))}`;
    const oldBeta = `NOL-SHP-${year}-${String(randomInt(100_000, 999_999))}`;
    await t.prisma.shipment.update({ where: { number: alphaShipment }, data: { number: old } });
    await t.prisma.shipment.update({ where: { number: betaShipment }, data: { number: oldBeta } });
    try {
      await me(`/shipments/${old}`, alphaToken).expect(200);
      await me(`/shipments/${old.slice('NOL-'.length)}`, alphaToken).expect(200);
      await me(`/shipments/${oldBeta.slice('NOL-'.length)}`, alphaToken).expect(404);
    } finally {
      await t.prisma.shipment.update({ where: { number: old }, data: { number: alphaShipment } });
      await t.prisma.shipment.update({
        where: { number: oldBeta },
        data: { number: betaShipment },
      });
    }
  });

  it('needs L2 for invoices', async () => {
    const { token: alphaToken } = await token(bot.key, alphaPhone);
    const refused = await me('/invoices', alphaToken).expect(403);
    expect(refused.body).toMatchObject({ code: 'L2_REQUIRED' });
  });

  it('refuses a token at once when the match, the customer or the key changes', async () => {
    const revokedBy = async (tokenValue: string) => {
      const refused = await me('/shipments', tokenValue).expect(401);
      expect(refused.body).toMatchObject({ code: 'GRANT_REVOKED' });
    };

    // The matched phone is changed.
    const own = await makeCustomer(cookies.salesPts, pts, {
      phone: uniquePhone(),
      name: `Delta ${tag}`,
    });
    const before = await token(bot.key, own.phone);
    await me('/shipments', before.token).expect(200);
    await patch(`/customers/${own.id}`, cookies.salesPts, { phone: uniquePhone() }).expect(200);
    await revokedBy(before.token);

    // The contact may no longer inquire.
    const contactPhone = uniquePhone();
    const withContact = await makeCustomer(cookies.salesPts, pts, {
      phone: uniquePhone(),
      name: `Epsilon ${tag}`,
    });
    const contacts = (
      await post(`/customers/${withContact.id}/contacts`, cookies.salesPts, {
        name: 'Inquirer',
        phone: contactPhone,
        canInquire: true,
      }).expect(201)
    ).body as CustomerDto;
    const contactId = contacts.contacts.find((k) => k.phone === contactPhone)?.id ?? '';
    const viaContact = await token(bot.key, contactPhone);
    await me('/shipments', viaContact.token).expect(200);
    await patch(`/customers/${withContact.id}/contacts/${contactId}`, cookies.salesPts, {
      canInquire: false,
    }).expect(200);
    await revokedBy(viaContact.token);

    // The customer is deactivated.
    const zeta = await makeCustomer(cookies.salesPts, pts, {
      phone: uniquePhone(),
      name: `Zeta ${tag}`,
    });
    const zetaToken = await token(bot.key, zeta.phone);
    await post(`/customers/${zeta.id}/deactivate`, cookies.salesPts).expect(200);
    await revokedBy(zetaToken.token);

    // The key loses the scope, a branch, or is revoked.
    const second = await makeKey([pts], ['cs:customer_tokens:issue']);
    const viaSecond = await token(second.key, alphaPhone);
    await put(`/api-clients/${second.client.id}/scopes`, cookies.admin, {
      scopes: ['cs:catalog:read'],
    }).expect(200);
    await revokedBy(viaSecond.token);

    const third = await makeKey([pts], ['cs:customer_tokens:issue']);
    const viaThird = await token(third.key, alphaPhone);
    await t.prisma.apiClientBranch.deleteMany({ where: { apiClientId: third.client.id } });
    await revokedBy(viaThird.token);

    const fourth = await makeKey([pts], ['cs:customer_tokens:issue']);
    const viaFourth = await token(fourth.key, alphaPhone);
    await post(`/api-clients/${fourth.client.id}/revoke`, cookies.admin).expect(200);
    await revokedBy(viaFourth.token);
  });

  it('ends a token when it expires, and knows no other token', async () => {
    const answer = await token(bot.key, alphaPhone);
    await t.prisma.csCustomerToken.updateMany({
      where: { customerId: alpha.id, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const refused = await me('/shipments', answer.token).expect(401);
    expect(refused.body).toMatchObject({ code: 'TOKEN_EXPIRED' });
    await me('/shipments', `nolct_${'a'.repeat(43)}`).expect(401);
    await me('/shipments', bot.key).expect(401);
  });

  it('logs every request in the append-only access log, with no phone', async () => {
    const events = await t.prisma.csAccessEvent.findMany({
      where: { apiClientId: bot.client.id },
      orderBy: { id: 'asc' },
    });
    const outcomes = new Set(events.map((e) => e.outcome));
    for (const outcome of ['TOKEN', 'NONE', 'CHOOSE', 'OK', 'NOT_FOUND', 'L2_REQUIRED']) {
      expect(outcomes).toContain(outcome);
    }
    expect(events.every((e) => e.channel === 'whatsapp')).toBe(true);
    const text = JSON.stringify(events, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    for (const phone of [alphaPhone, alphaWhatsapp, sharedPhone, betaPhone]) {
      expect(text).not.toContain(phone);
      expect(text).not.toContain(phone.slice(1));
    }
    const first = events[0];
    if (!first) throw new Error('No access events');
    await expect(
      t.prisma.csAccessEvent.update({ where: { id: first.id }, data: { outcome: 'X' } }),
    ).rejects.toThrow(/cannot be changed/);
    await expect(t.prisma.csAccessEvent.delete({ where: { id: first.id } })).rejects.toThrow(
      /cannot be changed/,
    );
  });
});
