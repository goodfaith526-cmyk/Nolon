import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import type {
  CsBookingRequestCreated,
  CsBookingRequestDto,
  CsBookingRequestStaffDto,
  CsPhotoUploaded,
} from '@nolon/shared';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../src/customer-service/api-key.js';
import { Prisma } from '../src/generated/prisma/client.js';
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
import { uniquePhone } from './test-data.js';

/**
 * Plan 09 section 12 (N-C9): photos the owner sends as raw bytes, staff's estimate of a request
 * with an item outside the standard categories, the owner's acceptance of one version, and
 * approval at that accepted estimate. Negative cases: the key alone, another sender, a file that
 * is not an image, an 11th photo, a reused key with other bytes, a person without the permission
 * or the branch, a request needing no estimate, a validity out of range, the switch off, an
 * accepted version replaced, an expired estimate, and approval without the current acceptance.
 */
describe('Customer Service estimates and photos (plan 09 section 12)', () => {
  let t: TestApp;
  let off: TestApp;
  const cookies = { sales: '', jed: '', ops: '' };
  let dxb = '';
  let customerId = '';
  const clientId = randomUUID();
  const key = newApiKey();
  const secret = 'test-channel-assertion-secret-32-characters';
  const tag = `E${randomUUID().slice(0, 5).toUpperCase()}`;
  const category = `${tag}B`;
  const originId = randomUUID();
  const destinationId = randomUUID();
  const elsewhereId = randomUUID();
  const terms = { originId, destinationId, mode: 'ROAD' };
  const telegramId = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const jpeg = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n & 0xff, (n >> 8) & 0xff]);

  /** A request by `senderId` with a standard item and an OTHER one (or the standard one only). */
  async function make(senderId: string, other = true, app = t): Promise<string> {
    const res = await app
      .http()
      .post('/api/v1/cs/booking-requests')
      .set('Authorization', `Bearer ${key.key}`)
      .send({
        sender: { channel: 'telegram', id: senderId },
        originId,
        destinationId,
        items: [
          { category, quantity: '2' },
          ...(other ? [{ kind: 'OTHER', description: 'A sofa', pieces: 2, weightKg: '60' }] : []),
        ],
        services: [],
        senderName: 'Sender',
        consigneeName: 'Consignee',
        consigneePhone: uniquePhone(),
        handover: 'BRANCH_DROP',
        language: 'ar',
        idempotencyKey: `idem-${randomUUID()}`,
      })
      .expect(201);
    return (res.body as CsBookingRequestCreated).requestId;
  }

  /** A POST signed (plan 08) for `subjectId` when given; the key alone otherwise. */
  function post(
    path: string,
    body: Buffer | string,
    opts: { subjectId?: string; idempotencyKey?: string; contentType?: string } = {},
    app = t,
  ) {
    const req = app
      .http()
      .post(path)
      .set('Authorization', `Bearer ${key.key}`)
      .set('Content-Type', opts.contentType ?? 'application/json');
    if (opts.idempotencyKey) req.set('Idempotency-Key', opts.idempotencyKey);
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
        clientId,
        'POST',
        path,
        opts.idempotencyKey ?? '',
        issued,
        sha256(rawContext),
        sha256(body),
      ].join('\n');
      const signature = createHmac('sha256', secret).update(payload).digest('base64url');
      req
        .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
        .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'));
    }
    return req.send(body);
  }
  const photo = (
    id: string,
    bytes: Buffer,
    subjectId?: string,
    idem: string = randomUUID(),
    app = t,
  ) =>
    post(
      `/api/v1/cs/booking-requests/${id}/photos`,
      bytes,
      { subjectId, idempotencyKey: idem, contentType: 'image/jpeg' },
      app,
    );
  const accept = (id: string, estimateVersion: number, subjectId: string, app = t) =>
    post(
      `/api/v1/cs/booking-requests/${id}/accept-estimate`,
      JSON.stringify({ estimateVersion }),
      { subjectId },
      app,
    );
  const read = (id: string, senderId: string) =>
    t
      .http()
      .get(`/api/v1/cs/booking-requests/${id}`)
      .set('Authorization', `Bearer ${key.key}`)
      .set('X-Cs-Sender', `telegram:${senderId}`)
      .expect(200)
      .then((r) => r.body as CsBookingRequestDto);
  const staff = (cookie: string, app = t) => ({
    get: (path: string) => app.http().get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object) =>
      app.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  const detail = async (id: string) =>
    (await staff(cookies.sales).get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  /** An async request with .expect(status), as supertest's own. */
  // Wrapped in { req }: a supertest request is itself awaitable and would run unchecked.
  const expecting = (
    made: Promise<{ req: { expect: (status: number) => Promise<Response> } }>,
  ) => ({
    expect: (status: number) => made.then(({ req }) => req.expect(status)),
  });
  const estimate = (
    id: string,
    amount = '120',
    cookie = cookies.sales,
    app = t,
    currency = 'USD',
  ) => expecting(estimateRequest(id, amount, cookie, app, currency));
  async function estimateRequest(
    id: string,
    amount: string,
    cookie: string,
    app: TestApp,
    currency: string,
  ) {
    const version = (
      (await staff(cookies.sales, app).get(`/cs-booking-requests/${id}`).expect(200))
        .body as CsBookingRequestStaffDto
    ).version;
    return {
      req: staff(cookie, app).post(`/cs-booking-requests/${id}/estimate`, {
        version,
        amount,
        currency,
        terms,
        noteAr: 'يشمل التغليف',
        validUntil: inDays(3),
      }),
    };
  }
  const approve = (
    id: string,
    pricing: object = { originId, destinationId, mode: 'ROAD', currency: 'USD' },
    services: string[] = [],
  ) =>
    expecting(
      detail(id).then((shown) => ({
        req: staff(cookies.sales).post(`/cs-booking-requests/${id}/approve`, {
          version: shown.version,
          paymentCurrency: 'USD',
          pricing,
          booking: { customerId, services },
        }),
      })),
    );
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  beforeAll(async () => {
    const config = { secret, accounts: [{ channel: 'TELEGRAM', channelAccountId: 'test-bot' }] };
    const env = {
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: `estimates-${randomUUID()}`,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify({ [clientId]: config }),
      CS_BOOKING_CANCEL_ENABLED: true,
    };
    t = await createTestApp({ ...env, CS_ESTIMATES_ENABLED: true });
    off = await createTestApp(env);
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    const sales = await createUser(t.prisma, ['SALES'], ['DXB'], LEDGER_PREFIX);
    cookies.sales = await signIn(t, sales.email);
    cookies.jed = await signIn(t, (await createUser(t.prisma, ['SALES'], ['JED'])).email);
    cookies.ops = await signIn(t, (await createUser(t.prisma, ['OPERATIONS'], ['DXB'])).email);
    dxb = await branchId(t.prisma, 'DXB');
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'BARREL',
        defaultUnit: 'PER_BARREL',
      },
    });
    for (const [id, suffix] of [
      [originId, 'O'],
      [destinationId, 'D'],
      [elsewhereId, 'X'],
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
    await t.prisma.apiClient.create({
      data: {
        id: clientId,
        name: 'Estimates test',
        keyPrefix: key.prefix,
        keyHash: key.hash,
        createdById: admin.id,
        customersRead: false,
        branches: { create: [{ branchId: dxb }] },
        scopes: { create: [{ scope: 'BOOKING_REQUESTS_CREATE', grantedById: admin.id }] },
      },
    });
    customerId = (
      await t.prisma.customer.create({
        data: {
          number: `${tag}-1`,
          branchId: dxb,
          name: `${tag} customer`,
          phone: uniquePhone(),
          kind: 'COMPANY',
          createdById: sales.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await t?.close();
    await off?.close();
  });

  it('takes photos from the proven owner only, as images read from their bytes', async () => {
    const sender = telegramId();
    const id = await make(sender);
    expect(code(await photo(id, jpeg(1)).expect(403))).toBe('OWNER_PROOF_REQUIRED');
    await photo(id, jpeg(1), telegramId()).expect(404);
    // A PDF sent as image/jpeg.
    expect(code(await photo(id, Buffer.from('%PDF-1.7\n'), sender).expect(415))).toBe(
      'UNSUPPORTED_IMAGE',
    );
    await photo(id, jpeg(1), sender, '').expect(400);
    const first = (await photo(id, jpeg(1), sender, 'p-1').expect(201)).body as CsPhotoUploaded;
    expect(first).toMatchObject({ contentType: 'image/jpeg', sizeBytes: 6, photoCount: 1 });
    // The same key and bytes: the same answer; other bytes: refused.
    expect((await photo(id, jpeg(1), sender, 'p-1').expect(200)).body).toEqual(first);
    expect(code(await photo(id, jpeg(2), sender, 'p-1').expect(409))).toBe('IDEMPOTENCY_CONFLICT');
    for (let n = 2; n <= 10; n += 1) await photo(id, jpeg(n), sender, `p-${n}`).expect(201);
    expect(code(await photo(id, jpeg(11), sender, 'p-11').expect(409))).toBe('PHOTO_LIMIT');
    expect((await read(id, sender)).photoCount).toBe(10);

    // Staff of the branch see it inline in its stored type; another branch does not.
    const shown = await detail(id);
    expect(shown.photos).toHaveLength(10);
    const got = await staff(cookies.sales)
      .get(`/cs-booking-requests/${id}/photos/${first.photoId}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['content-disposition']).toBe('inline');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(got.body as Buffer, jpeg(1))).toBe(0);
    await staff(cookies.jed).get(`/cs-booking-requests/${id}/photos/${first.photoId}`).expect(404);
  });

  it('refuses a photo over 10 MB, and takes photos while estimates are off', async () => {
    const sender = telegramId();
    const id = await make(sender);
    const big = Buffer.concat([jpeg(0), Buffer.alloc(10 * 1024 * 1024)]);
    expect(code(await photo(id, big, sender).expect(413))).toBe('PHOTO_TOO_LARGE');
    // Codex F171-3: sent in parts, with a declared length or none, the client still sending gets
    // the 413 answer itself (never a reset socket).
    const server = t.app.getHttpServer() as Server;
    if (!server.listening) await new Promise<void>((done) => server.listen(0, done));
    const { port } = server.address() as AddressInfo;
    const mb = 1024 * 1024;
    const send = (declared: boolean) =>
      new Promise<{ status: number; body: string }>((done, fail) => {
        const req = httpRequest(
          {
            port,
            method: 'POST',
            path: `/api/v1/cs/booking-requests/${id}/photos`,
            headers: {
              Authorization: `Bearer ${key.key}`,
              'Content-Type': 'image/jpeg',
              ...(declared
                ? { 'Content-Length': String(11 * mb) }
                : { 'Transfer-Encoding': 'chunked' }),
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (body += c));
            res.on('end', () => done({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', fail);
        const part = Buffer.alloc(mb);
        let n = 0;
        const next = () => {
          if (n === 11) return void req.end();
          n += 1;
          req.write(part, () => setImmediate(next));
        };
        next();
      });
    for (const declared of [true, false]) {
      const answered = await send(declared);
      expect(answered.status).toBe(413);
      expect(JSON.parse(answered.body)).toMatchObject({ code: 'PHOTO_TOO_LARGE' });
    }
    const other = await make(sender, true, off);
    await photo(other, jpeg(3), sender, randomUUID(), off).expect(201);
    expect(code(await estimate(other, '10', cookies.sales, off).expect(503))).toBe(
      'ESTIMATES_UNAVAILABLE',
    );
    expect(code(await accept(other, 1, sender, off).expect(503))).toBe('ESTIMATES_UNAVAILABLE');
  });

  it('lets only staff deciding in the branch estimate a request that needs it, within 14 days', async () => {
    const sender = telegramId();
    const id = await make(sender);
    expect((await detail(id)).actions.canEstimate).toBe(true);
    await estimate(id, '120', cookies.ops).expect(403);
    await estimate(id, '120', cookies.jed).expect(404);
    await estimate(id, '0').expect(400);
    const version = (await detail(id)).version;
    for (const validUntil of [inDays(-1), inDays(15)]) {
      await staff(cookies.sales)
        .post(`/cs-booking-requests/${id}/estimate`, {
          version,
          amount: '10',
          currency: 'USD',
          validUntil,
        })
        .expect(400);
    }
    const plain = await make(sender, false);
    expect((await detail(plain)).actions.canEstimate).toBe(false);
    expect(code(await estimate(plain).expect(409))).toBe('ESTIMATE_NOT_NEEDED');
    // Without an estimate, a request with an OTHER item is not approved.
    expect(code(await approve(id).expect(409))).toBe('ESTIMATE_REQUIRED');
  });

  it('approves only at the version the customer accepted, and a new estimate needs a new accept', async () => {
    const sender = telegramId();
    const id = await make(sender);
    const v1 = (await estimate(id, '120').expect(201)).body as CsBookingRequestStaffDto;
    expect(v1.status).toBe('estimated');
    expect(v1.estimate).toMatchObject({ version: 1, amount: '120', acceptedVersion: null });
    const shown = await read(id, sender);
    expect(shown).toMatchObject({
      status: 'estimated',
      estimate: {
        version: 1,
        amount: '120',
        currency: 'USD',
        note: { ar: 'يشمل التغليف', en: 'يشمل التغليف' },
      },
    });
    expect(shown.expiresAt).toBe(shown.estimate?.validUntil);
    expect(code(await approve(id).expect(409))).toBe('ESTIMATE_REQUIRED');
    expect(code(await accept(id, 2, sender).expect(409))).toBe('ESTIMATE_CHANGED');
    await accept(id, 1, telegramId()).expect(404);
    const accepted = await accept(id, 1, sender).expect(200);
    expect(accepted.body).toEqual({ requestId: id, status: 'pending', acceptedVersion: 1 });
    expect((await accept(id, 1, sender).expect(200)).body).toEqual(accepted.body);
    expect(await read(id, sender)).toMatchObject({ status: 'pending', estimate: null });

    // A new estimate clears the acceptance (F165-2): approval waits for v2 to be accepted.
    const v2 = (await estimate(id, '150').expect(201)).body as CsBookingRequestStaffDto;
    expect(v2.estimate).toMatchObject({ version: 2, amount: '150', acceptedVersion: null });
    expect(code(await approve(id).expect(409))).toBe('ESTIMATE_REQUIRED');
    expect(code(await accept(id, 1, sender).expect(409))).toBe('ESTIMATE_CHANGED');
    await accept(id, 2, sender).expect(200);
    const approved = (await approve(id).expect(201)).body as CsBookingRequestStaffDto;
    expect(approved.status).toBe('approved');
    expect((await read(id, sender)).approvedPrice).toEqual({ amount: '150', currency: 'USD' });
    // The standard item books its category and quantity; the OTHER item its pieces as GENERAL.
    const lines = await t.prisma.bookingItem.findMany({
      where: { bookingId: approved.bookingId! },
      orderBy: { lineNo: 'asc' },
    });
    expect(lines.map((l) => [l.cargoType, l.quantity, l.priceCategoryCode])).toEqual([
      ['BARREL', 2, category],
      ['GENERAL', 2, null],
    ]);
    expect(lines[1]).toMatchObject({ description: 'A sofa' });
    expect(lines[1]?.weightKg?.toString()).toBe('60');
  });

  it('refuses an expired estimate, and the customer may decline one by cancelling', async () => {
    const sender = telegramId();
    const id = await make(sender);
    await estimate(id).expect(201);
    const past = new Date(Date.now() - 60_000);
    await t.prisma.csBookingRequest.update({
      where: { id },
      data: { estimateValidUntil: past, expiresAt: past },
    });
    expect(code(await accept(id, 1, sender).expect(409))).toBe('ESTIMATE_EXPIRED');
    expect(await read(id, sender)).toMatchObject({ status: 'expired', estimate: null });

    const declined = await make(sender);
    await estimate(declined).expect(201);
    await post(`/api/v1/cs/booking-requests/${declined}/cancel`, '{}', {
      subjectId: sender,
    }).expect(200);
    expect((await read(declined, sender)).status).toBe('cancelled');
  });

  it('never keeps an old acceptance with a new amount when both race (F165-2)', async () => {
    const sender = telegramId();
    const id = await make(sender);
    await estimate(id, '100').expect(201);
    const version = (await detail(id)).version;
    await Promise.all([
      accept(id, 1, sender),
      staff(cookies.sales).post(`/cs-booking-requests/${id}/estimate`, {
        version,
        amount: '200',
        currency: 'USD',
        terms,
        validUntil: inDays(3),
      }),
    ]);
    const row = await t.prisma.csBookingRequest.findUniqueOrThrow({ where: { id } });
    // Either the acceptance won (v1 accepted, the stale estimate refused) or the new estimate
    // did (v2, nothing accepted): never v1 accepted with v2's amount.
    if (row.estimateVersion === 1) {
      expect(row).toMatchObject({ status: 'PENDING', estimateAcceptedVersion: 1 });
      expect(row.estimateAmount?.toString()).toBe('100');
    } else {
      expect(row).toMatchObject({ estimateVersion: 2, estimateAcceptedVersion: null });
      expect(row.estimateAmount?.toString()).toBe('200');
    }
  });

  it('approves only while the estimate currency is active (F171-1)', async () => {
    const sender = telegramId();
    const id = await make(sender);
    const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const code3 = `Q${letter()}${letter()}`;
    await t.prisma.currency.upsert({
      where: { code: code3 },
      create: { code: code3, nameEn: code3, nameAr: code3 },
      update: { isActive: true },
    });
    await estimate(id, '120', cookies.sales, t, code3).expect(201);
    await accept(id, 1, sender).expect(200);
    await t.prisma.currency.update({ where: { code: code3 }, data: { isActive: false } });
    expect(code(await approve(id).expect(409))).toBe('ESTIMATE_CURRENCY_INACTIVE');
    expect((await detail(id)).status).toBe('pending');
  });

  it('approves only the route, mode and services the estimate priced (F171-2)', async () => {
    const sender = telegramId();
    const id = await make(sender);
    await estimate(id).expect(201);
    expect((await detail(id)).estimate?.terms).toEqual({ ...terms, loadType: null });
    await accept(id, 1, sender).expect(200);
    const changed = 'ESTIMATE_TERMS_CHANGED';
    const pricing = { originId, destinationId, mode: 'ROAD', currency: 'USD' };
    expect(code(await approve(id, { ...pricing, destinationId: elsewhereId }).expect(409))).toBe(
      changed,
    );
    expect(code(await approve(id, { ...pricing, mode: 'SEA' }).expect(409))).toBe(changed);
    const withPickup = await staff(cookies.sales).post(`/cs-booking-requests/${id}/approve`, {
      version: (await detail(id)).version,
      paymentCurrency: 'USD',
      pricing,
      booking: { customerId, services: ['PICKUP'] },
    });
    expect(withPickup.status).toBe(409);
    expect(code(withPickup)).toBe(changed);
    // An estimate recorded with no terms is never approved.
    await t.prisma.csBookingRequest.update({
      where: { id },
      data: { estimateTerms: Prisma.DbNull },
    });
    expect(code(await approve(id).expect(409))).toBe(changed);
    // Staff must name the terms with the estimate.
    const shown = await detail(id);
    await staff(cookies.sales)
      .post(`/cs-booking-requests/${id}/estimate`, {
        version: shown.version,
        amount: '90',
        currency: 'USD',
        validUntil: inDays(3),
      })
      .expect(400);
    // A new estimate on the new terms, accepted again, approves them.
    const again = (await detail(id)).version;
    await staff(cookies.sales)
      .post(`/cs-booking-requests/${id}/estimate`, {
        version: again,
        amount: '90',
        currency: 'USD',
        terms: { ...terms, destinationId: elsewhereId },
        validUntil: inDays(3),
      })
      .expect(201);
    // The bot reads the terms the estimate prices before the customer accepts it.
    expect((await read(id, sender)).estimate).toMatchObject({
      version: 2,
      terms: {
        origin: { code: `${tag}O` },
        destination: { code: `${tag}X`, ar: 'مدينة اختبار', en: `${tag}X` },
        mode: 'ROAD',
        loadType: null,
        services: [],
      },
    });
    await accept(id, 2, sender).expect(200);
    await approve(id, { ...pricing, destinationId: elsewhereId }).expect(201);
  });
});
