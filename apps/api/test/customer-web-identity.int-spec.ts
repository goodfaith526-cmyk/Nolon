import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { CsQuotationSaved, CsQuotesDto, CustomerChatWarningsDto } from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import type { IdentityResult } from '../src/customer-service/customer-identity.contract.js';
import { WEB_NEW_VISITORS_PER_DAY } from '../src/customer-service/customer-identity.service.js';
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
 * Website chat visitors (owner, 2026-11-06): a signed WEB identity (`web` + 16 hex, under a WEB
 * channel account the key lists, Codex F214-1) gets its customer file once the visitor gives a name, a
 * booking request bound to it, and the bot's quotes saved in it. Negative cases: a key listing no
 * WEB account, another website account, a malformed visitor id, phone evidence, no name, a typed phone another file
 * holds (never linked), the daily cap on new visitors.
 */
describe('Customer Service website identity', () => {
  let t: TestApp;
  let off: TestApp;
  let dxb = '';
  const clientId = randomUUID();
  const key = newApiKey();
  const secret = 'test-channel-assertion-secret-32-characters';
  const companyId = `web-${randomUUID()}`;
  const tag = `W${randomUUID().slice(0, 5).toUpperCase()}`;
  const category = tag;
  const originId = randomUUID();
  const destinationId = randomUUID();

  type Who = {
    channel: string;
    subjectId: string;
    channelAccountId: string;
    eventId: string;
    observedAt: string;
  };
  const visitor = (extra: Partial<Who> = {}): Who => ({
    channel: 'WEB',
    subjectId: `web${randomBytes(8).toString('hex')}`,
    channelAccountId: 'nolon',
    eventId: randomUUID(),
    observedAt: new Date().toISOString(),
    ...extra,
  });
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  /** A signed POST as the bot makes it (plan 08 channel assertion). */
  function call(app: TestApp, path: string, body: object, who: Who, idem = randomUUID()) {
    const rawBody = JSON.stringify(body);
    const rawContext = JSON.stringify({
      channel: who.channel,
      subjectId: who.subjectId,
      channelAccountId: who.channelAccountId,
      eventId: who.eventId,
      observedAt: who.observedAt,
    });
    const issued = Math.floor(Date.now() / 1000).toString();
    const fullPath = `/api/v1${path}`;
    const payload = [
      'v1',
      clientId,
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
      .set('Authorization', `Bearer ${key.key}`)
      .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
      .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'))
      .set('Idempotency-Key', idem)
      .set('Content-Type', 'application/json')
      .send(rawBody);
  }

  const capture = (who: Who, fields: object = {}, extra: object = {}, app = t) =>
    call(
      app,
      '/cs/customer-profiles/capture',
      {
        schemaVersion: 'nolon.customer-identity/1',
        conversationId: randomUUID(),
        sender: { ...who, ...extra },
        fields,
      },
      who,
    );
  const named = (name: string) => ({ name: { value: name, source: 'CUSTOMER_STATEMENT' } });
  const accountsOf = (profileId: string) => t.prisma.customer.findMany({ where: { profileId } });

  beforeAll(async () => {
    const env = {
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_ACCOUNT_ENABLED: true,
      CS_CUSTOMER_BOOKING_IDENTITY_ENABLED: true,
      CS_QUOTE_SAVE_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: companyId,
    };
    const telegram = { channel: 'TELEGRAM', channelAccountId: 'test-bot' };
    const clients = (accounts: object[]) => JSON.stringify({ [clientId]: { secret, accounts } });
    t = await createTestApp({
      ...env,
      CS_CUSTOMER_IDENTITY_CLIENTS: clients([
        telegram,
        { channel: 'WEB', channelAccountId: 'nolon' },
      ]),
    });
    // The same key listing only its Telegram bot: no website visitor (Codex F214-1).
    off = await createTestApp({ ...env, CS_CUSTOMER_IDENTITY_CLIENTS: clients([telegram]) });
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    dxb = await branchId(t.prisma, 'DXB');
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
      [originId, 'O'],
      [destinationId, 'D'],
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
    await t.prisma.branchRoutingRule.create({ data: { locationId: originId, branchId: dxb } });
    await t.prisma.rateCard.create({
      data: {
        branchId: dxb,
        originLocationId: originId,
        destinationLocationId: destinationId,
        mode: 'ROAD',
        loadType: null,
        cargoType: 'GENERAL',
        chargeTypeCode: 'FREIGHT',
        priceCategoryCode: category,
        unit: 'PER_SHIPMENT',
        price: '100',
        minimumCharge: '0',
        currency: 'USD',
        validFrom: new Date(Date.now() - 30 * 86_400_000),
        status: 'APPROVED',
        createdById: admin.id,
        approvedById: admin.id,
        approvedAt: new Date(),
      },
    });
    await t.prisma.apiClient.create({
      data: {
        id: clientId,
        name: 'Web identity test',
        keyPrefix: key.prefix,
        keyHash: key.hash,
        createdById: admin.id,
        customersRead: false,
        branches: { create: [{ branchId: dxb }] },
        scopes: {
          create: [
            { scope: 'CUSTOMER_PROFILES_WRITE', grantedById: admin.id },
            { scope: 'BOOKING_REQUESTS_CREATE', grantedById: admin.id },
            { scope: 'QUOTE_READ', grantedById: admin.id },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await t?.close();
    await off?.close();
  });

  it('accepts a website visitor only under a WEB account the key lists', async () => {
    expect(code(await capture(visitor(), named('Off visitor'), {}, off).expect(403))).toBe(
      'CHANNEL_NOT_ALLOWED',
    );
    expect(
      code(await capture(visitor({ channelAccountId: 'other-site' }), named('X')).expect(403)),
    ).toBe('CHANNEL_NOT_ALLOWED');
    // The visitor id is `web` and 16 lowercase hex digits; nothing else.
    await capture(visitor({ subjectId: randomBytes(8).toString('hex') }), named('X')).expect(400);
    await capture(visitor({ subjectId: 'web123' }), named('X')).expect(400);
    // A website identity proves no phone.
    const who = visitor();
    await capture(who, named('X'), {
      phoneEvidence: { value: '+971501234567', kind: 'TELEGRAM_OWN_CONTACT', contactUserId: '1' },
    }).expect(400);
  });

  it('opens the file once the visitor gives a name, never from the chat, and only one', async () => {
    const who = visitor();
    const first = (await capture(who, {}, { displayName: 'Browser label' }).expect(201))
      .body as IdentityResult;
    expect(await accountsOf(first.profileId!)).toHaveLength(0);
    const second = (
      await capture({ ...who, eventId: randomUUID() }, named('Web Visitor')).expect(200)
    ).body as IdentityResult;
    expect(second.profileId).toBe(first.profileId);
    const accounts = await accountsOf(first.profileId!);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ name: 'Web Visitor', createdViaApiClientId: clientId });
    // The same name from another browser is another visitor, another file: never merged by name.
    const other = (await capture(visitor(), named('Web Visitor')).expect(201))
      .body as IdentityResult;
    expect(other.profileId).not.toBe(first.profileId);
  });

  it('never links a typed phone another file holds: the claimer gets a file with a warning', async () => {
    const phone = `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const holder = (
      await capture(visitor(), {
        ...named('Phone holder'),
        phone: { value: phone, source: 'CUSTOMER_STATEMENT' },
      }).expect(201)
    ).body as IdentityResult;
    const claimer = (
      await capture(visitor(), {
        ...named('Phone claimer'),
        phone: { value: phone, source: 'CUSTOMER_STATEMENT' },
      }).expect(201)
    ).body as IdentityResult;
    expect(claimer.outcome).toBe('CREATED');
    expect(claimer.profileId).not.toBe(holder.profileId);
    // Owner, 2026-11-05: the typed phone is in the holder's file, marked unverified.
    expect(await accountsOf(holder.profileId!)).toMatchObject([{ phone, phoneUnverified: true }]);
    // Owner, 2026-11-07: the claimer has their own file, named, without that phone; staff see the
    // phone as a warning naming the holder's file.
    const [own] = await accountsOf(claimer.profileId!);
    expect(own).toMatchObject({ name: 'Phone claimer', phone: null });
  });

  it('adds a phone given later to the file, from the chat or from a booking request', async () => {
    const later = `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const who = visitor();
    const conversationId = randomUUID();
    const send = (fields: object, sender = who) =>
      call(
        t,
        '/cs/customer-profiles/capture',
        { schemaVersion: 'nolon.customer-identity/1', conversationId, sender, fields },
        sender,
      );
    const first = (await send(named('Later phone')).expect(201)).body as IdentityResult;
    expect(await accountsOf(first.profileId!)).toMatchObject([{ phone: null }]);
    await send(
      { phone: { value: later, source: 'CUSTOMER_STATEMENT' } },
      { ...who, eventId: randomUUID() },
    ).expect(200);
    expect(await accountsOf(first.profileId!)).toMatchObject([
      { phone: later, phoneUnverified: true },
    ]);

    // A visitor who typed the phone only in the booking request.
    const booker = visitor();
    const bookerConversation = randomUUID();
    const bookerProfile = (
      (
        await call(
          t,
          '/cs/customer-profiles/capture',
          {
            schemaVersion: 'nolon.customer-identity/1',
            conversationId: bookerConversation,
            sender: booker,
            fields: named('Booking phone'),
          },
          booker,
        ).expect(201)
      ).body as IdentityResult
    ).profileId!;
    const book = (contactPhone: string) => {
      const idempotencyKey = randomUUID();
      return call(
        t,
        '/cs/booking-requests',
        {
          idempotencyKey,
          profileId: bookerProfile,
          conversationId: bookerConversation,
          sender: { channel: 'web', id: booker.subjectId.slice(3) },
          contactPhone,
          originId,
          destinationId,
          category,
          quantity: '1',
          services: [],
          senderName: 'Booking phone',
          consigneeName: 'Receiver',
          consigneePhone: '0912345678',
          handover: 'BRANCH_DROP',
          language: 'ar',
        },
        booker,
        idempotencyKey,
      ).expect(201);
    };
    // A phone another customer holds is never taken; the file keeps none.
    await book(later);
    expect(await accountsOf(bookerProfile)).toMatchObject([{ phone: null }]);
    const own = `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    await book(own);
    expect(await accountsOf(bookerProfile)).toMatchObject([{ phone: own, phoneUnverified: true }]);
    // A phone already in the file is never replaced.
    await book(`+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`);
    expect(await accountsOf(bookerProfile)).toMatchObject([{ phone: own }]);

    // Codex F220-1: a stranger's request bringing that typed phone is never linked to the file.
    const stranger = await t
      .http()
      .post('/api/v1/cs/booking-requests')
      .set('Authorization', `Bearer ${key.key}`)
      .send({
        idempotencyKey: randomUUID(),
        sender: { channel: 'web', id: randomBytes(8).toString('hex') },
        contactPhone: own,
        originId,
        destinationId,
        category,
        quantity: '1',
        services: [],
        senderName: 'Stranger',
        consigneeName: 'Receiver',
        consigneePhone: '0912345678',
        handover: 'BRANCH_DROP',
        language: 'ar',
      })
      .expect(201);
    const strangerRow = await t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: (stranger.body as { requestId: string }).requestId },
    });
    const [file] = await accountsOf(bookerProfile);
    expect(strangerRow.instantCustomerId).not.toBeNull();
    expect(strangerRow.instantCustomerId).not.toBe(file!.id);
  });

  it('binds a booking request to the visitor file, and saves the quotes in it', async () => {
    const who = visitor();
    const conversationId = randomUUID();
    const captured = (
      await call(
        t,
        '/cs/customer-profiles/capture',
        {
          schemaVersion: 'nolon.customer-identity/1',
          conversationId,
          sender: who,
          fields: named('Booking visitor'),
        },
        who,
      ).expect(201)
    ).body as IdentityResult;
    const [account] = await accountsOf(captured.profileId!);

    const idempotencyKey = randomUUID();
    const booked = await call(
      t,
      '/cs/booking-requests',
      {
        idempotencyKey,
        profileId: captured.profileId,
        conversationId,
        sender: { channel: 'web', id: who.subjectId.slice(3) },
        originId,
        destinationId,
        category,
        quantity: '1',
        services: [],
        senderName: 'Booking visitor',
        consigneeName: 'Receiver',
        consigneePhone: '0912345678',
        handover: 'BRANCH_DROP',
        language: 'ar',
      },
      who,
      idempotencyKey,
    ).expect(201);
    const request = await t.prisma.csBookingRequest.findUniqueOrThrow({
      where: { id: (booked.body as { requestId: string }).requestId },
    });
    expect(request).toMatchObject({
      profileId: captured.profileId,
      senderChannel: 'web',
      senderId: who.subjectId.slice(3),
    });
    // Another channel's sender, or the visitor id with its `web` prefix (Codex F214-3), is refused.
    for (const [wrongSender, status] of [
      [{ channel: 'telegram', id: '12345' }, 401],
      [{ channel: 'web', id: who.subjectId }, 400],
    ] as const) {
      const wrongKey = randomUUID();
      await call(
        t,
        '/cs/booking-requests',
        {
          idempotencyKey: wrongKey,
          profileId: captured.profileId,
          conversationId,
          sender: wrongSender,
          originId,
          destinationId,
          category,
          quantity: '1',
          services: [],
          senderName: 'Booking visitor',
          consigneeName: 'Receiver',
          consigneePhone: '0912345678',
          handover: 'BRANCH_DROP',
          language: 'ar',
        },
        who,
        wrongKey,
      ).expect(status);
    }

    const quoted = await t
      .http()
      .post('/api/v1/cs/quotes')
      .set('Authorization', `Bearer ${key.key}`)
      .send({ originId, destinationId, items: [{ category, quantity: '2' }] })
      .expect(200);
    const refs = (quoted.body as CsQuotesDto).items.map((i) => i.quote!.quoteRef);
    const saved = (await call(t, '/cs/quotations', { quoteRefs: refs }, who).expect(201))
      .body as CsQuotationSaved;
    const quotation = await t.prisma.quotation.findUniqueOrThrow({
      where: { id: saved.quotationId },
    });
    expect(quotation).toMatchObject({
      customerId: account!.id,
      source: 'BOT_QUOTE',
      branchId: dxb,
    });
    // A visitor with no name yet has no file: nothing is saved.
    const nameless = visitor();
    await capture(nameless).expect(201);
    const [ref] = (
      (
        await t
          .http()
          .post('/api/v1/cs/quotes')
          .set('Authorization', `Bearer ${key.key}`)
          .send({ originId, destinationId, items: [{ category, quantity: '1' }] })
          .expect(200)
      ).body as CsQuotesDto
    ).items.map((i) => i.quote!.quoteRef);
    expect(code(await call(t, '/cs/quotations', { quoteRefs: [ref] }, nameless).expect(409))).toBe(
      'CUSTOMER_NOT_READY',
    );
  });

  it('fills the file with the address and city given, follows a completed name, and shows doubtful values to staff as warnings', async () => {
    // Owner, 2026-11-07: the file is always made and filled; a doubtful value is a warning only.
    const phone = `+97150${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const holder = (
      await capture(visitor(), {
        ...named('Warn holder'),
        phone: { value: phone, source: 'CUSTOMER_STATEMENT' },
      }).expect(201)
    ).body as IdentityResult;
    const [held] = await accountsOf(holder.profileId!);
    const who = visitor();
    const claimer = (
      await capture(who, {
        ...named('Warn claimer'),
        phone: { value: phone, source: 'CUSTOMER_STATEMENT' },
        address: { value: 'Street 1', source: 'CUSTOMER_STATEMENT' },
        residenceCityId: { value: originId, source: 'CUSTOMER_STATEMENT' },
      }).expect(201)
    ).body as IdentityResult;
    const [file] = await accountsOf(claimer.profileId!);
    expect(file).toMatchObject({
      name: 'Warn claimer',
      phone: null,
      address: 'Street 1',
      city: 'مدينة اختبار',
      countryCode: 'AE',
    });
    // A completed name follows into the file; a different one is a warning and changes nothing.
    await capture({ ...who, eventId: randomUUID() }, named('Warn claimer Full')).expect(200);
    await capture({ ...who, eventId: randomUUID() }, named('Somebody Else')).expect(200);
    expect((await accountsOf(claimer.profileId!))[0]).toMatchObject({ name: 'Warn claimer Full' });

    // Their review record is append-only: the users stay, as the ledger tests' (LEDGER_PREFIX).
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    const driver = await createUser(t.prisma, ['DRIVER'], ['DXB'], LEDGER_PREFIX);
    const cookie = await signIn(t, admin.email);
    const path = `/api/v1/customer-profiles/customer/${file!.id}/warnings`;
    const read = async () =>
      (await t.http().get(path).set('Cookie', cookie).expect(200)).body as CustomerChatWarningsDto;
    const warned = await read();
    expect(warned.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'phone', value: phone, heldBy: [held!.number] }),
        expect.objectContaining({ field: 'name', value: 'Somebody Else', heldBy: [] }),
      ]),
    );
    expect(warned.warnings.some((w) => w.value === 'Warn claimer Full')).toBe(false);
    // Missing permission, a stale version, then seen: only newer warnings show.
    const driverCookie = await signIn(t, driver.email);
    await t.http().get(path).set('Cookie', driverCookie).expect(403);
    await t
      .http()
      .post(`${path}/seen`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .send({ expectedVersion: warned.profileVersion! - 1 })
      .expect(409);
    await t
      .http()
      .post(`${path}/seen`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .send({ expectedVersion: warned.profileVersion })
      .expect(201);
    expect((await read()).warnings).toEqual([]);
    await capture({ ...who, eventId: randomUUID() }, named('Third Name')).expect(200);
    expect((await read()).warnings).toEqual([
      expect.objectContaining({ field: 'name', value: 'Third Name' }),
    ]);
    // The holder's file shows nothing: their own values were all taken.
    expect(
      (
        (
          await t
            .http()
            .get(`/api/v1/customer-profiles/customer/${held!.id}/warnings`)
            .set('Cookie', cookie)
            .expect(200)
        ).body as CustomerChatWarningsDto
      ).warnings,
    ).toEqual([]);
  });
  it(`starts at most ${WEB_NEW_VISITORS_PER_DAY} new visitors a key a day`, async () => {
    const made = await t.prisma.customerChannelIdentity.count({
      where: { companyId, channel: 'WEB' },
    });
    // Visitors made by earlier tests count; fill up to the cap directly, as earlier captures did.
    for (let i = made; i < WEB_NEW_VISITORS_PER_DAY; i += 1) {
      const identity = await t.prisma.customerChannelIdentity.create({
        data: {
          companyId,
          channel: 'WEB',
          subjectId: `web${randomBytes(8).toString('hex')}`,
          observedAt: new Date(),
        },
      });
      await t.prisma.customerProfileConversation.create({
        data: {
          companyId,
          apiClientId: clientId,
          conversationId: randomUUID(),
          identityId: identity.id,
        },
      });
    }
    expect(code(await capture(visitor(), named('Over the cap')).expect(429))).toBe('CAPTURE_LIMIT');
    // A Telegram sender is not counted.
    await capture(
      {
        ...visitor(),
        channel: 'TELEGRAM',
        subjectId: `${Date.now()}`,
        channelAccountId: 'test-bot',
      },
      named('Telegram sender'),
    ).expect(201);
  });
});
