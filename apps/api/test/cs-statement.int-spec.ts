import { randomInt, randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  BookingDto,
  CsBookingRequestCreated,
  CsCustomerTokenAnswer,
  CsStatementDto,
  CustomerDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, toDbDate, todayIn } from '../src/common/dates.js';
import { startOfDayIn } from '../src/common/list-filters.js';
import { newApiKey } from '../src/customer-service/api-key.js';
import {
  monthsBefore,
  STATEMENT_TIMEZONE,
  statementPeriod,
} from '../src/customer-service/customer-statement.service.js';
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

/**
 * GET /cs/me/statement (plan 14-2). Negative cases: switch off, no or expired token, another
 * customer, a branch the key does not serve, a request linked only by a typed phone, a Telegram
 * `tel:` id, a contact's token (no invoice data at all), bad ranges; plus the row cap with
 * totals over every invoice, Khartoum day boundaries, and one access-log row per read.
 */
describe('Customer statement (plan 14-2)', () => {
  let on: TestApp;
  let off: TestApp;
  let noPdf: TestApp;
  let renderer: Server;
  let rendered = '';
  let renderAnswer = '%PDF-1.7 fake';
  let dxb = '';
  let jed = '';
  let admin = '';
  let salesDxb = '';
  let salesJed = '';
  let adminId = '';
  const clientId = randomUUID();
  const key = newApiKey();
  const tag = String(randomInt(100_000, 999_999));
  const category = `S${randomUUID().slice(0, 6).toUpperCase()}`;
  const originId = randomUUID();
  const destinationId = randomUUID();
  const alphaPhone = uniquePhone();
  const contactPhone = uniquePhone();
  const betaPhone = uniquePhone();
  let alpha: CustomerDto;
  let beta: CustomerDto;
  let receivableId = '';
  let periodId = '';
  let n = 0;
  const num = () => `ST${tag}-${++n}`;
  const today = todayIn(STATEMENT_TIMEZONE);

  const api = (app: TestApp) => ({
    post: (path: string, cookie: string, body: object = {}) =>
      app.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  const statement = (app: TestApp, token: string, query = '') =>
    app
      .http()
      .get(`/api/v1/cs/me/statement${query ? `?${query}` : ''}`)
      .set('Authorization', `Bearer ${token}`);
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const body = (res: { body: unknown }) => res.body as CsStatementDto;

  async function token(app: TestApp, phone: string): Promise<TokenAnswer> {
    const answer = (
      await app
        .http()
        .post('/api/v1/cs/customer-tokens')
        .set('Authorization', `Bearer ${key.key}`)
        .send({ phone })
        .expect(200)
    ).body as CsCustomerTokenAnswer;
    if (answer.kind !== 'token') throw new Error(`Expected a token, got ${answer.kind}`);
    return answer;
  }

  /** A bot request through the key for a WhatsApp sender, then moved to `createdAt` if given. */
  async function request(
    senderPhone: string,
    data: Record<string, unknown> = {},
  ): Promise<{ id: string; reference: string }> {
    const res = await on
      .http()
      .post('/api/v1/cs/booking-requests')
      .set('Authorization', `Bearer ${key.key}`)
      .send({
        sender: { channel: 'whatsapp', id: senderPhone },
        originId,
        destinationId,
        category,
        quantity: '2',
        services: [],
        senderName: 'Sender',
        consigneeName: 'Consignee',
        consigneePhone: uniquePhone(),
        handover: 'BRANCH_DROP',
        language: 'ar',
        idempotencyKey: `idem-${randomUUID()}`,
      })
      .expect(201);
    const created = res.body as CsBookingRequestCreated;
    const row = await on.prisma.csBookingRequest.update({
      where: { id: created.requestId },
      data,
    });
    return { id: row.id, reference: row.reference };
  }

  /** A request made with a token of `customerId` (link 1): a customer owner, no sender. */
  const owned = (customerId: string) => ({
    customerId,
    grantId: `g${'0'.repeat(40)}`,
    senderChannel: null,
    senderId: null,
  });

  async function booking(cookie: string, customer: CustomerDto): Promise<string> {
    const loc = async (c: string) =>
      (await on.prisma.location.findUniqueOrThrow({ where: { code: c } })).id;
    return (
      (
        await api(on)
          .post('/bookings', cookie, {
            customerId: customer.id,
            originLocationId: await loc('SDPZU'),
            destinationLocationId: await loc('SDKRT'),
            mode: 'ROAD',
            cargoType: 'GENERAL',
            services: ['MAIN_FREIGHT'],
            cargoDescription: `Goods ${tag}`,
            items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: '100' }],
          })
          .expect(201)
      ).body as BookingDto
    ).number;
  }

  /** An approved opening invoice written straight to the table (no journal is posted). */
  async function invoice(
    customerId: string,
    branch: string,
    date: string,
    amounts: { currency?: string; total: string; paid: string },
  ): Promise<string> {
    const entry = await on.prisma.journalEntry.create({
      data: {
        number: num(),
        branchId: branch,
        entryDate: toDbDate(date),
        periodId,
        description: tag,
        source: 'CUSTOMER_INVOICE',
        createdById: adminId,
      },
    });
    const currency = amounts.currency ?? 'USD';
    const row = await on.prisma.customerInvoice.create({
      data: {
        number: num(),
        branchId: branch,
        customerId,
        currency,
        fxRate: currency === 'USD' ? '1' : '600',
        invoiceDate: toDbDate(date),
        dueDate: toDbDate(date),
        status: 'APPROVED',
        total: amounts.total,
        totalUsd: amounts.total,
        paidAmount: amounts.paid,
        paidUsd: amounts.paid,
        isOpening: true,
        journalEntryId: entry.id,
        receivableAccountId: receivableId,
        approvedAt: new Date(),
        approvedById: adminId,
        createdById: adminId,
      },
    });
    return row.number ?? '';
  }

  beforeAll(async () => {
    // A fake renderer (plan 14-3): answers `renderAnswer`, keeps the HTML it was sent.
    renderer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        rendered = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(renderAnswer);
      });
    });
    await new Promise<void>((resolve) => renderer.listen(0, '127.0.0.1', resolve));
    const port = (renderer.address() as AddressInfo).port;
    on = await createTestApp({
      CS_STATEMENT_ENABLED: true,
      PDF_RENDERER_URL: `http://127.0.0.1:${port}`,
    });
    off = await createTestApp({ CS_STATEMENT_ENABLED: false });
    noPdf = await createTestApp({ CS_STATEMENT_ENABLED: true, PDF_RENDERER_URL: undefined });
    dxb = await branchId(on.prisma, 'DXB');
    jed = await branchId(on.prisma, 'JED');
    const users = {
      admin: await createUser(on.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      salesDxb: await createUser(on.prisma, ['SALES'], ['DXB'], LEDGER_PREFIX),
      salesJed: await createUser(on.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
    };
    adminId = users.admin.id;
    admin = await signIn(on, users.admin.email);
    salesDxb = await signIn(on, users.salesDxb.email);
    salesJed = await signIn(on, users.salesJed.email);
    await on.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: `Cat ${category}`,
        nameAr: 'صنف اختبار',
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    for (const [id, suffix] of [
      [originId, 'O'],
      [destinationId, 'D'],
    ] as const) {
      await on.prisma.location.create({
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
    await on.prisma.branchRoutingRule.create({ data: { locationId: originId, branchId: dxb } });
    await on.prisma.apiClient.create({
      data: {
        id: clientId,
        name: `Statement test ${tag}`,
        keyPrefix: key.prefix,
        keyHash: key.hash,
        createdById: adminId,
        customersRead: false,
        branches: { create: [{ branchId: dxb }] },
        scopes: {
          create: [
            { scope: 'CUSTOMER_TOKENS_ISSUE', grantedById: adminId },
            { scope: 'BOOKING_REQUESTS_CREATE', grantedById: adminId },
          ],
        },
      },
    });
    const makeCustomer = async (phone: string, name: string) =>
      (
        await api(on)
          .post('/customers', admin, {
            branchId: dxb,
            kind: 'INDIVIDUAL',
            preferredCurrency: 'USD',
            phone,
            name,
          })
          .expect(201)
      ).body as CustomerDto;
    alpha = await makeCustomer(alphaPhone, `Alpha ${tag}`);
    beta = await makeCustomer(betaPhone, `Beta ${tag}`);
    await api(on)
      .post(`/customers/${alpha.id}/contacts`, admin, {
        name: 'Inquirer',
        phone: contactPhone,
        canInquire: true,
      })
      .expect(201);
    receivableId = (
      await on.prisma.account.create({
        data: {
          code: `ST${tag}`,
          nameEn: 'Statement receivable',
          nameAr: 'ذمم',
          type: 'ASSET',
        },
      })
    ).id;
    const existing = await on.prisma.fiscalPeriod.findFirst();
    periodId =
      existing?.id ??
      (
        await on.prisma.fiscalPeriod.create({
          data: {
            year: 2093,
            month: 1,
            startDate: toDbDate('2093-01-01'),
            endDate: toDbDate('2093-01-31'),
          },
        })
      ).id;
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
    await noPdf?.close();
    renderer?.close();
  });

  it('checks the period: defaults, 366 days, order, the future, bad dates', () => {
    expect(statementPeriod({}, '2026-11-05')).toEqual({ from: '2026-05-05', to: '2026-11-05' });
    expect(monthsBefore('2026-08-31', 6)).toBe('2026-02-28');
    expect(statementPeriod({ from: '2025-11-05', to: '2026-11-05' }, '2026-11-05')).not.toBeNull();
    expect(statementPeriod({ from: '2025-11-04', to: '2026-11-05' }, '2026-11-05')).toBeNull();
    expect(statementPeriod({ from: '2026-11-05', to: '2026-11-04' }, '2026-11-05')).toBeNull();
    expect(statementPeriod({ to: '2026-11-06' }, '2026-11-05')).toBeNull();
    expect(statementPeriod({ from: '2026-13-01' }, '2026-11-05')).toBeNull();
  });

  it('is off by default (503, logged), needs a valid token, and 400s a bad range (logged)', async () => {
    const tok = await token(on, alphaPhone);
    expect(code(await statement(off, tok.token).expect(503))).toBe('STATEMENT_UNAVAILABLE');
    await statement(on, 'nolct_' + 'x'.repeat(43)).expect(401);
    expect(code(await statement(on, tok.token, 'from=2020-01-01&to=2021-06-01').expect(400))).toBe(
      'INVALID_RANGE',
    );
    expect(code(await statement(on, tok.token, 'from=bad').expect(400))).toBe('INVALID_RANGE');
    expect(code(await statement(on, tok.token, `to=${addDays(today, 1)}`).expect(400))).toBe(
      'INVALID_RANGE',
    );
    const row = await on.prisma.csCustomerToken.findFirstOrThrow({
      where: { customerId: alpha.id },
      orderBy: { issuedAt: 'desc' },
    });
    const outcomes = (
      await on.prisma.csAccessEvent.findMany({
        where: { tokenId: row.id, route: 'GET /cs/me/statement' },
        orderBy: { id: 'asc' },
      })
    ).map((e) => e.outcome);
    expect(outcomes).toEqual(['UNAVAILABLE', 'INVALID_RANGE', 'INVALID_RANGE', 'INVALID_RANGE']);
    await on.prisma.csCustomerToken.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(code(await statement(on, tok.token).expect(401))).toBe('TOKEN_EXPIRED');
  });

  it('logs and refuses an unknown, repeated or too long query value (F209-2); switch first (F209-4)', async () => {
    const tok = await token(on, alphaPhone);
    for (const q of ['month=1', 'from=2026-01-01&from=2026-02-01', `from=${'2'.repeat(11)}`]) {
      expect(code(await statement(on, tok.token, q).expect(400))).toBe('INVALID_RANGE');
    }
    expect(pdfCode(await pdf(on, tok.token, 'lang=en&lang=ar').expect(400))).toBe('INVALID_RANGE');
    const tokenId = await lastTokenId(alpha.id);
    const outcomes = (
      await on.prisma.csAccessEvent.findMany({
        where: { tokenId, route: 'GET /cs/me/statement' },
        orderBy: { id: 'asc' },
      })
    ).map((e) => e.outcome);
    expect(outcomes).toEqual(['INVALID_RANGE', 'INVALID_RANGE', 'INVALID_RANGE']);
    expect((await pdfLog(tokenId)).map((e) => e.outcome)).toEqual(['INVALID_RANGE']);
    expect(pdfCode(await pdf(off, tok.token, 'lang=fr&x=1').expect(503))).toBe(
      'STATEMENT_UNAVAILABLE',
    );
    expect((await pdfLog(tokenId)).map((e) => e.outcome)).toEqual(['INVALID_RANGE', 'UNAVAILABLE']);
  });

  it("holds only the token holder's requests, the customer's bookings, in the key's branches", async () => {
    const mineByToken = await request(uniquePhone(), owned(alpha.id));
    // Link 3 (F206-5): the same WhatsApp sender, stored without '+'.
    const mineBySender = await request(alphaPhone, { senderId: alphaPhone.slice(1) });
    const mineCancelled = await request(alphaPhone, { status: 'CANCELLED' });
    // F206-1: a typed-phone website link, and a Telegram `tel:` id, are not proof.
    const website = await request(uniquePhone(), {
      instantCustomerId: alpha.id,
      instantAccount: 'REUSED',
    });
    const typedTelegram = await request(uniquePhone(), {
      senderChannel: 'telegram',
      senderId: `tel:${alphaPhone.slice(1)}`,
    });
    const others = await request(betaPhone, owned(beta.id));
    // F206-6: an unrouted request whose candidates are all outside the key's branches.
    const unrouted = await request(alphaPhone, {
      branchId: null,
      status: 'AWAITING_ROUTING',
      allowedBranchIds: [jed],
    });
    const unroutedInside = await request(alphaPhone, {
      branchId: null,
      status: 'AWAITING_ROUTING',
      allowedBranchIds: [jed, dxb],
    });
    const bookingDxb = await booking(salesDxb, alpha);
    const bookingJed = await booking(salesJed, alpha);
    const bookingBeta = await booking(salesDxb, beta);

    const tok = await token(on, alphaPhone);
    const s = body(await statement(on, tok.token).expect(200));
    const refs = s.requests.rows.map((r) => r.reference);
    expect(refs).toEqual(
      expect.arrayContaining([
        mineByToken.reference,
        mineBySender.reference,
        mineCancelled.reference,
        unroutedInside.reference,
      ]),
    );
    for (const absent of [website, typedTelegram, others, unrouted]) {
      expect(refs).not.toContain(absent.reference);
    }
    const cancelled = s.requests.rows.find((r) => r.reference === mineCancelled.reference);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      goods: { category: { en: `Cat ${category}` }, quantity: '2', unit: 'PER_SHIPMENT' },
    });
    const numbers = s.bookings.rows.map((b) => b.number);
    expect(numbers).toContain(bookingDxb);
    expect(numbers).not.toContain(bookingJed);
    expect(numbers).not.toContain(bookingBeta);
    expect(s.bookings.rows.find((b) => b.number === bookingDxb)).toMatchObject({
      cargoDescription: `Goods ${tag}`,
      status: 'DRAFT',
      shipment: null,
    });
    expect(s).toMatchObject({ customer: { number: alpha.number }, invoicesHidden: null });
    const logged = await on.prisma.csAccessEvent.count({
      where: { route: 'GET /cs/me/statement', outcome: 'OK', customerId: alpha.id },
    });
    expect(logged).toBeGreaterThanOrEqual(1);
  });

  it('uses Khartoum days: both boundary days are in, the days outside are out (F206-8)', async () => {
    const from = addDays(today, -20);
    const to = addDays(today, -10);
    const at = (date: string, minutes: number) =>
      new Date(startOfDayIn(date, STATEMENT_TIMEZONE).getTime() + minutes * 60_000);
    const first = await request(uniquePhone(), { ...owned(alpha.id), createdAt: at(from, 0) });
    const last = await request(uniquePhone(), {
      ...owned(alpha.id),
      createdAt: at(to, 23 * 60 + 59),
    });
    const before = await request(uniquePhone(), { ...owned(alpha.id), createdAt: at(from, -1) });
    const after = await request(uniquePhone(), {
      ...owned(alpha.id),
      createdAt: at(addDays(to, 1), 0),
    });
    const tok = await token(on, alphaPhone);
    const refs = body(
      await statement(on, tok.token, `from=${from}&to=${to}`).expect(200),
    ).requests.rows.map((r) => r.reference);
    expect(refs).toEqual(expect.arrayContaining([first.reference, last.reference]));
    expect(refs).not.toContain(before.reference);
    expect(refs).not.toContain(after.reference);
  });

  it('caps invoices at 200 with totals over all of them, and exact decimals (F206-2)', async () => {
    const date = addDays(today, -40);
    // The oldest, the one left out by the cap, carries the only balance.
    await invoice(beta.id, dxb, addDays(date, -1), { total: '50.0005', paid: '0' });
    for (let i = 0; i < 200; i += 1) {
      await invoice(beta.id, dxb, date, { total: '10.10', paid: '10.10' });
    }
    await invoice(beta.id, jed, date, { total: '999', paid: '0' });
    const tok = await token(on, betaPhone);
    const s = body(
      await statement(on, tok.token, `from=${addDays(date, -1)}&to=${date}`).expect(200),
    );
    expect(s.invoices).not.toBeNull();
    const inv = s.invoices!;
    expect(inv.rows).toHaveLength(200);
    expect(inv).toMatchObject({ count: 201, truncated: true });
    expect(inv.totals).toEqual([
      {
        currency: 'USD',
        count: 201,
        total: '2070.0005',
        paid: '2020',
        credited: '0',
        balance: '50.0005',
      },
    ]);
  });

  it("gives an authorized person's token no invoice data at all (F206-3)", async () => {
    await invoice(alpha.id, dxb, addDays(today, -5), { total: '70', paid: '0' });
    const tok = await token(on, contactPhone);
    const s = body(await statement(on, tok.token).expect(200));
    expect(s.invoices).toBeNull();
    expect(s.invoicesHidden).toBe('CONTACT');
    expect(JSON.stringify(s)).not.toContain('"balance"');
    // The customer's own number sees them.
    const own = body(await statement(on, (await token(on, alphaPhone)).token).expect(200));
    expect(own.invoices?.totals[0]).toMatchObject({ currency: 'USD', balance: '70' });
  });

  it('keeps /cs/me/invoices at L2 for the same L1 token (F206-4)', async () => {
    const tok = await token(on, alphaPhone);
    expect(tok.level).toBe('L1');
    await statement(on, tok.token).expect(200);
    const res = await on
      .http()
      .get('/api/v1/cs/me/invoices')
      .set('Authorization', `Bearer ${tok.token}`)
      .expect(403);
    expect(code(res)).toBe('L2_REQUIRED');
  });

  const pdf = (app: TestApp, tok: string, query = '') =>
    app
      .http()
      .get(`/api/v1/cs/me/statement/pdf${query ? `?${query}` : ''}`)
      .set('Authorization', `Bearer ${tok}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const pdfCode = (res: { body: unknown }) =>
    (JSON.parse((res.body as Buffer).toString('utf8')) as { code?: string }).code;
  const pdfLog = (tokenId: string) =>
    on.prisma.csAccessEvent.findMany({
      where: { tokenId, route: 'GET /cs/me/statement/pdf' },
      orderBy: { id: 'asc' },
    });
  const lastTokenId = async (customerId: string) =>
    (
      await on.prisma.csCustomerToken.findFirstOrThrow({
        where: { customerId },
        orderBy: { issuedAt: 'desc' },
      })
    ).id;

  it('answers the PDF, attachment and no-store, logged OK (plan 14-3)', async () => {
    renderAnswer = '%PDF-1.7 fake';
    const tok = await token(on, alphaPhone);
    const res = await pdf(on, tok.token, 'lang=en').expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(
        `^attachment; filename="statement-${alpha.number}-\\d{4}-\\d{2}-\\d{2}-${today}\\.pdf"$`,
      ),
    );
    expect((res.body as Buffer).toString('latin1')).toBe('%PDF-1.7 fake');
    expect(rendered).toContain('dir="ltr"');
    expect(rendered).not.toMatch(/https?:\/\//);
    expect((await pdfLog(await lastTokenId(alpha.id))).map((e) => e.outcome)).toEqual(['OK']);
  });

  it("sends the renderer no invoice data for an authorized person's token (F206-3)", async () => {
    const tok = await token(on, contactPhone);
    await pdf(on, tok.token).expect(200);
    expect(rendered).toContain('dir="rtl"');
    expect(rendered).not.toContain('<h2>الفواتير</h2>');
    expect(rendered).not.toContain('<h2>الإجماليات</h2>');
  });

  it('503s and logs a renderer that answers no PDF, or none configured; 400s a bad lang', async () => {
    renderAnswer = '<html>not a pdf</html>';
    const tok = await token(on, alphaPhone);
    expect(pdfCode(await pdf(on, tok.token).expect(503))).toBe('PDF_FAILED');
    renderAnswer = '%PDF-1.7 fake';
    expect(pdfCode(await pdf(on, tok.token, 'lang=fr').expect(400))).toBe('INVALID_LANG');
    expect((await pdfLog(await lastTokenId(alpha.id))).map((e) => e.outcome)).toEqual([
      'PDF_FAILED',
      'INVALID_LANG',
    ]);
    const other = await token(noPdf, alphaPhone);
    expect(pdfCode(await pdf(noPdf, other.token).expect(503))).toBe('PDF_UNAVAILABLE');
    expect((await pdfLog(await lastTokenId(alpha.id))).map((e) => e.outcome)).toEqual([
      'PDF_UNAVAILABLE',
    ]);
    // The JSON statement still works without a renderer.
    await statement(noPdf, other.token).expect(200);
  });
});
