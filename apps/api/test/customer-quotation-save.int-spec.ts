import { createHmac, randomUUID } from 'node:crypto';
import type { CsQuotationSaved, CsQuotesDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import {
  APP_ORIGIN,
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';

/**
 * POST /cs/quotations (owner, 2026-11-05): the prices the bot gave its customer are saved in
 * Quotations, as one SENT quotation (source BOT_QUOTE) for the customer the signed sender proves.
 * Negative cases: the switch off, the key alone, a bad signature, a sender with no customer file,
 * a blocked sender, another key's quote, an expired quote, a quote without a total, quotes that
 * differ, a branch the key does not serve, quotes saved before in another quotation.
 */
describe('Customer Service quotation save', () => {
  let t: TestApp;
  let off: TestApp;
  let dxb = '';
  let jed = '';
  let adminId = '';
  const clientId = randomUUID();
  const otherId = randomUUID();
  const key = newApiKey();
  const otherKey = newApiKey();
  const secret = 'test-channel-assertion-secret-32-characters';
  const companyId = `quote-save-${randomUUID()}`;
  const tag = `S${randomUUID().slice(0, 5).toUpperCase()}`;
  const category = `${tag}A`;
  const category2 = `${tag}B`;
  const originId = randomUUID();
  const destinationId = randomUUID();
  const jedOriginId = randomUUID();

  const telegramId = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  async function quotes(
    items: { category: string; quantity?: string }[],
    opts: { token?: string; origin?: string } = {},
  ): Promise<string[]> {
    const res = await t
      .http()
      .post('/api/v1/cs/quotes')
      .set('Authorization', `Bearer ${opts.token ?? key.key}`)
      .send({ originId: opts.origin ?? originId, destinationId, items })
      .expect(200);
    return (res.body as CsQuotesDto).items.map((i) => i.quote!.quoteRef);
  }

  /** POST /cs/quotations, signed (plan 08) for `subjectId` when given; the key alone otherwise. */
  function save(
    quoteRefs: string[],
    opts: { subjectId?: string; sign?: string; app?: TestApp; other?: boolean } = {},
  ) {
    const path = '/api/v1/cs/quotations';
    const raw = JSON.stringify({ quoteRefs });
    const req = (opts.app ?? t)
      .http()
      .post(path)
      .set('Authorization', `Bearer ${opts.other ? otherKey.key : key.key}`)
      .set('Content-Type', 'application/json');
    if (opts.subjectId) {
      const rawContext = JSON.stringify({
        channel: 'TELEGRAM',
        subjectId: opts.subjectId,
        channelAccountId: 'test-bot',
        eventId: randomUUID(),
        observedAt: new Date().toISOString(),
      });
      const issued = Math.floor(Date.now() / 1000).toString();
      const payload = [
        'v1',
        opts.other ? otherId : clientId,
        'POST',
        path,
        '',
        issued,
        sha256(rawContext),
        sha256(raw),
      ].join('\n');
      const signature = createHmac('sha256', opts.sign ?? secret)
        .update(payload)
        .digest('base64url');
      req
        .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
        .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'));
    }
    return req.send(raw);
  }

  /** A Telegram sender with a profile and its central customer (as captured from its first message). */
  async function customerSender(opts: { blocked?: boolean; customer?: boolean } = {}) {
    const subjectId = telegramId();
    const profile = await t.prisma.customerProfile.create({
      data: { companyId, number: `CP${randomUUID().slice(0, 8)}`, name: 'Quote customer' },
    });
    await t.prisma.customerChannelIdentity.create({
      data: {
        companyId,
        channel: 'TELEGRAM',
        subjectId,
        observedAt: new Date(),
        profileId: profile.id,
        blocked: opts.blocked ?? false,
      },
    });
    let customerId: string | null = null;
    if (opts.customer ?? true) {
      const customer = await t.prisma.customer.create({
        data: {
          number: `CS${randomUUID().slice(0, 8)}`,
          kind: 'INDIVIDUAL',
          name: 'Quote customer',
          profileId: profile.id,
          createdViaApiClientId: clientId,
        },
      });
      customerId = customer.id;
    }
    return { subjectId, customerId };
  }

  beforeAll(async () => {
    const config = { secret, accounts: [{ channel: 'TELEGRAM', channelAccountId: 'test-bot' }] };
    const env = {
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: companyId,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({ [clientId]: config, [otherId]: config }),
    };
    t = await createTestApp({ ...env, CS_QUOTE_SAVE_ENABLED: true });
    off = await createTestApp({ ...env, CS_QUOTE_SAVE_ENABLED: false });
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    adminId = admin.id;
    dxb = await branchId(t.prisma, 'DXB');
    jed = await branchId(t.prisma, 'JED');
    for (const [c, unit] of [
      [category, 'PER_SHIPMENT'],
      [category2, 'PER_KG'],
    ] as const) {
      await t.prisma.priceCategory.create({
        data: { code: c, nameEn: c, nameAr: c, cargoType: 'GENERAL', defaultUnit: unit },
      });
    }
    for (const [id, suffix] of [
      [originId, 'O'],
      [destinationId, 'D'],
      [jedOriginId, 'J'],
    ] as const) {
      await t.prisma.location.create({
        data: {
          id,
          code: `${tag}${suffix}`,
          nameEn: `${tag}${suffix}`,
          nameAr: 'مدينة اختبار',
          kind: 'CITY',
          countryCode: 'AE',
        },
      });
    }
    const card = (branch: string, origin: string, priceCategoryCode: string, unit: string) =>
      t.prisma.rateCard.create({
        data: {
          branchId: branch,
          originLocationId: origin,
          destinationLocationId: destinationId,
          mode: 'ROAD',
          loadType: null,
          cargoType: 'GENERAL',
          chargeTypeCode: 'FREIGHT',
          priceCategoryCode,
          unit: unit as 'PER_SHIPMENT' | 'PER_KG',
          price: unit === 'PER_KG' ? '2.5' : '100',
          minimumCharge: '0',
          currency: 'USD',
          validFrom: new Date(Date.now() - 30 * 86_400_000),
          status: 'APPROVED',
          createdById: adminId,
          approvedById: adminId,
          approvedAt: new Date(),
        },
      });
    await card(dxb, originId, category, 'PER_SHIPMENT');
    await card(dxb, originId, category2, 'PER_KG');
    await card(jed, jedOriginId, category, 'PER_SHIPMENT');
    for (const [id, k] of [
      [clientId, key],
      [otherId, otherKey],
    ] as const) {
      await t.prisma.apiClient.create({
        data: {
          id,
          name: 'Quote save test',
          keyPrefix: k.prefix,
          keyHash: k.hash,
          createdById: adminId,
          customersRead: false,
          branches: { create: [{ branchId: dxb }] },
          scopes: {
            create: [
              { scope: 'QUOTE_READ', grantedById: adminId },
              { scope: 'BOOKING_REQUESTS_CREATE', grantedById: adminId },
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

  it('is off behind the switch, and needs the sender proven', async () => {
    const { subjectId } = await customerSender();
    const refs = await quotes([{ category, quantity: '1' }]);
    expect(code(await save(refs, { subjectId, app: off }).expect(503))).toBe(
      'QUOTE_SAVE_UNAVAILABLE',
    );
    expect(code(await save(refs).expect(403))).toBe('OWNER_PROOF_REQUIRED');
    await save(refs, { subjectId, sign: 'another-secret-of-at-least-32-characters' }).expect(401);
    expect(await t.prisma.csQuoteSave.count({ where: { quoteRef: { in: refs } } })).toBe(0);
  });

  it("saves one answer's quotes as one sent quotation for the sender's customer, once", async () => {
    const { subjectId, customerId } = await customerSender();
    const refs = await quotes([
      { category, quantity: '2' },
      { category: category2, quantity: '40' },
    ]);
    const first = await save(refs, { subjectId }).expect(201);
    const body = first.body as CsQuotationSaved;
    expect(body).toMatchObject({ status: 'SENT', currency: 'USD', total: '300.00', created: true });
    expect(body.number).toMatch(/^QT/);
    const row = await t.prisma.quotation.findUniqueOrThrow({
      where: { id: body.quotationId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    expect(row).toMatchObject({
      customerId,
      branchId: dxb,
      source: 'BOT_QUOTE',
      status: 'SENT',
      createdById: adminId,
      createdViaApiClientId: clientId,
      originLocationId: originId,
      destinationLocationId: destinationId,
      mode: 'ROAD',
    });
    expect(row.sentAt).not.toBeNull();
    expect(row.lines.map((l) => [l.priceCategoryCode, l.lineTotal.toFixed(2)])).toEqual([
      [category, '200.00'],
      [category2, '100.00'],
    ]);
    expect(row.lines.every((l) => l.priceSource === 'RATE_CARD' && l.rateCardId)).toBe(true);
    // The same quotes again: the same quotation, nothing new.
    const again = await save(refs, { subjectId }).expect(200);
    expect(again.body).toMatchObject({ quotationId: body.quotationId, created: false });
    expect(await t.prisma.quotation.count({ where: { customerId: customerId! } })).toBe(1);
    // Part of them with a new one, or another sender: refused.
    const [extra] = await quotes([{ category, quantity: '1' }]);
    expect(code(await save([refs[0]!, extra!], { subjectId }).expect(409))).toBe(
      'QUOTE_ALREADY_SAVED',
    );
    const stranger = await customerSender();
    expect(code(await save(refs, { subjectId: stranger.subjectId }).expect(409))).toBe(
      'QUOTE_ALREADY_SAVED',
    );
  });

  it('answers a replay only while the key still serves the quotation branch (F203-1)', async () => {
    const { subjectId } = await customerSender();
    const refs = await quotes([{ category, quantity: '1' }], { token: otherKey.key });
    await save(refs, { subjectId, other: true }).expect(201);
    await t.prisma.apiClientBranch.deleteMany({ where: { apiClientId: otherId, branchId: dxb } });
    const replay = await save(refs, { subjectId, other: true }).expect(422);
    expect(code(replay)).toBe('BRANCH_NOT_SERVED');
    expect(replay.body).not.toHaveProperty('quotationId');
  });

  it('staff see it in Quotations, marked as from the bot, and may approve and book it', async () => {
    const { subjectId, customerId } = await customerSender();
    const refs = await quotes([{ category, quantity: '1' }]);
    const saved = (await save(refs, { subjectId }).expect(201)).body as CsQuotationSaved;
    const staff = await signIn(
      t,
      (await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX)).email,
    );
    const listed = await t
      .http()
      .get(`/api/v1/quotations?pageSize=50&q=${saved.number}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', staff)
      .expect(200);
    const items = (listed.body as { items: { id: string; source: string }[] }).items;
    expect(items.find((q) => q.id === saved.quotationId)?.source).toBe('BOT_QUOTE');
    const approved = await t
      .http()
      .post(`/api/v1/quotations/${saved.quotationId}/approve`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', staff)
      .expect(200);
    expect((approved.body as { status: string }).status).toBe('APPROVED');
    // Booked as any approved quotation: the booking form opens from it.
    const preview = await t
      .http()
      .get(`/api/v1/bookings/from-quotation/${saved.quotationId}`)
      .set('Cookie', staff)
      .expect(200);
    expect(preview.body).toMatchObject({
      quotationId: saved.quotationId,
      customerId,
      branchId: dxb,
    });
  });

  it('refuses a sender with no customer file, or blocked', async () => {
    const refs = await quotes([{ category, quantity: '1' }]);
    const noFile = await customerSender({ customer: false });
    expect(code(await save(refs, { subjectId: noFile.subjectId }).expect(409))).toBe(
      'CUSTOMER_NOT_READY',
    );
    expect(code(await save(refs, { subjectId: telegramId() }).expect(409))).toBe(
      'CUSTOMER_NOT_READY',
    );
    const blocked = await customerSender({ blocked: true });
    expect(code(await save(refs, { subjectId: blocked.subjectId }).expect(409))).toBe(
      'CUSTOMER_NOT_READY',
    );
  });

  it("refuses another key's quote, an expired one, one without a total, and mixed quotes", async () => {
    const { subjectId } = await customerSender();
    const [foreign] = await quotes([{ category, quantity: '1' }], { token: otherKey.key });
    expect(code(await save([foreign!], { subjectId }).expect(404))).toBe('QUOTE_NOT_FOUND');

    // Quotes never change (a trigger): yesterday's, as GET /cs/quote kept it then.
    const [today] = await quotes([{ category, quantity: '1' }]);
    const kept = await t.prisma.csQuote.findUniqueOrThrow({ where: { ref: today! } });
    const expired = `q_${randomUUID().replaceAll('-', '')}`;
    await t.prisma.csQuote.create({
      data: { ...kept, ref: expired, expiresAt: new Date(Date.now() - 1000), createdAt: undefined },
    });
    expect(code(await save([expired], { subjectId }).expect(422))).toBe('QUOTE_EXPIRED');

    const [bare] = await quotes([{ category }]);
    expect(code(await save([bare!], { subjectId }).expect(422))).toBe('QUOTE_WITHOUT_TOTAL');

    const [here] = await quotes([{ category, quantity: '1' }]);
    const [there] = await quotes([{ category, quantity: '1' }], { origin: jedOriginId });
    expect(code(await save([here!, there!], { subjectId }).expect(422))).toBe('QUOTES_DIFFER');
    // Priced by JED's card, a branch this key does not serve.
    expect(code(await save([there!], { subjectId }).expect(422))).toBe('BRANCH_NOT_SERVED');
    await save([here!, here!], { subjectId }).expect(400);
  });
});
