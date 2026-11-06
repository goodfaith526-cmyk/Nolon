import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AccountDto,
  ApiClientCreatedDto,
  CsApprovalPriceDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  CsBookingRequestStaffDto,
  ReceiptDto,
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
import { sha256 } from '../src/customer-service/customer-identity-auth.js';
import { uniquePhone } from './test-data.js';

/**
 * Plan 13-5 (owner, 2026-11-06): one document for each thing the customer hands over, the
 * waybill for the parcel and a receipt for the fees. The request's read gives its proven owner
 * short-lived links; the download checks the key, the owner and the document again, and renders the
 * PDF then (the renderer faked here). Negative cases: the key alone, another sender, another key,
 * an expired link, a cancelled goods receipt or receipt, the switch off. Approved invoices post
 * entries, so the users are LEDGER users and every customer is this run's own.
 */
describe('the waybill and the receipts for the bot (plan 13-5)', () => {
  let on: TestApp;
  let off: TestApp;
  let renderer: Server;
  let rendered = '';
  const secret = 'test-channel-assertion-secret-32-characters';
  let pts = '';
  let bot: ApiClientCreatedDto;
  let other: ApiClientCreatedDto;
  const cookies = { admin: '', sales: '' };
  const ids: Record<string, string> = {};
  let category = '';
  let cash: AccountDto;
  const tag = `D${randomUUID().slice(0, 5).toUpperCase()}`;
  const route = { originId: '', destinationId: '', mode: 'ROAD', currency: 'USD' };

  const staff = (cookie: string) => ({
    get: (path: string, query: object = {}) =>
      on.http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      on.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });

  /** A GET as the bot `key` for `subjectId`, with its signed identity unless `unsigned`. */
  function asBot(app: TestApp, path: string, subjectId: string, key = bot, unsigned = false) {
    const req = app
      .http()
      .get(path)
      .set('Authorization', `Bearer ${key.key}`)
      .set('X-Cs-Sender', `telegram:${subjectId}`);
    if (unsigned) return req;
    const rawContext = JSON.stringify({
      channel: 'TELEGRAM',
      subjectId,
      channelAccountId: 'test-bot',
      eventId: randomUUID(),
      observedAt: new Date().toISOString(),
    });
    const issued = Math.floor(Date.now() / 1000).toString();
    const payload = [
      'v1',
      key.client.id,
      'GET',
      path,
      '',
      issued,
      sha256(rawContext),
      sha256(''),
    ].join('\n');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return req
      .set('X-Nolon-Channel-Assertion', `v1:${issued}:${signature}`)
      .set('X-Nolon-Channel-Context', Buffer.from(rawContext).toString('base64url'));
  }

  const read = async (app: TestApp, id: string, subjectId: string, unsigned = false) =>
    (await asBot(app, `/api/v1/cs/booking-requests/${id}`, subjectId, bot, unsigned).expect(200))
      .body as CsBookingRequestDto;
  /** The path of a link NOLON gave (on its public address). */
  const pathOf = (url: string) => new URL(url).pathname;

  /** An approved bot request of 4 barrels (40 USD, invoice approved), from a Telegram sender. */
  async function approvedRequest(): Promise<{ id: string; subjectId: string; shipmentId: string }> {
    const subjectId = `${Date.now()}${randomInt(100_000)}`;
    const id = (
      (
        await on
          .http()
          .post('/api/v1/cs/booking-requests')
          .set('Authorization', `Bearer ${bot.key}`)
          .send({
            sender: { channel: 'telegram', id: subjectId },
            originId: ids.origin,
            destinationId: ids.dest,
            services: [],
            senderName: 'Sender <script>x</script>',
            consigneeName: 'Consignee',
            consigneePhone: '0912345678',
            handover: 'PICKUP',
            language: 'ar',
            idempotencyKey: `docs-${randomUUID()}`,
            items: [{ category, quantity: '4' }],
          })
          .expect(201)
      ).body as CsBookingRequestCreated
    ).requestId;
    const sales = staff(cookies.sales);
    const price = (
      await sales
        .get(`/cs-booking-requests/${id}/price`, { ...route, category, quantity: '4' })
        .expect(200)
    ).body as CsApprovalPriceDto;
    const detail = (await sales.get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;
    const customerId = (
      await on.prisma.customer.create({
        data: {
          number: `${tag}-${randomUUID().slice(0, 6)}`,
          name: `${tag} customer`,
          phone: uniquePhone(),
          kind: 'COMPANY',
          preferredCurrency: 'USD',
          createdById: ids.sales!,
        },
      })
    ).id;
    const approved = (
      await sales
        .post(`/cs-booking-requests/${id}/approve`, {
          version: detail.version,
          paymentCurrency: 'USD',
          pricing: route,
          lines: [{ category, quantity: '4', pricingFingerprint: price.pricingFingerprint }],
          booking: { customerId, services: [] },
        })
        .expect(201)
    ).body as CsBookingRequestStaffDto;
    const shipment = await on.prisma.shipment.findUniqueOrThrow({
      where: { bookingId: approved.bookingId! },
    });
    return { id, subjectId, shipmentId: shipment.id };
  }

  const receive = (shipmentId: string) =>
    staff(cookies.admin)
      .post(`/shipments/${shipmentId}/warehouse/receipts`, {
        warehouseId: ids.warehouse,
        packages: 4,
        weightKg: '20',
        condition: 'GOOD',
      })
      .expect(201);

  async function pay(shipmentId: string, amount: string): Promise<ReceiptDto> {
    const invoice = await on.prisma.customerInvoice.findFirstOrThrow({
      where: { shipmentId, status: 'APPROVED' },
    });
    return (
      await staff(cookies.admin)
        .post('/receipts', {
          customerId: invoice.customerId,
          branchId: pts,
          receiptDate: new Date().toISOString().slice(0, 10),
          currency: 'USD',
          amount,
          cashAccountId: cash.id,
          reference: 'DOC-1',
          allocations: [{ invoiceId: invoice.id, amount }],
        })
        .expect(201)
    ).body as ReceiptDto;
  }

  beforeAll(async () => {
    renderer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        rendered = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/pdf' }).end('%PDF-1.7 fake');
      });
    });
    await new Promise<void>((resolve) => renderer.listen(0, '127.0.0.1', resolve));
    const port = (renderer.address() as AddressInfo).port;
    // Created first, so the identity settings can name its id.
    const first = await createTestApp({});
    pts = await branchId(first.prisma, 'PTS');
    const admin = await createUser(first.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    cookies.admin = await signIn(first, admin.email);
    const sales = await createUser(first.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX);
    ids.sales = sales.id;
    cookies.sales = await signIn(first, sales.email);
    const key = async (name: string) =>
      (
        await first
          .http()
          .post('/api/v1/api-clients')
          .set('Origin', APP_ORIGIN)
          .set('Cookie', cookies.admin)
          .send({ name, branchIds: [pts], scopes: ['cs:booking_requests:create', 'cs:quote:read'] })
          .expect(201)
      ).body as ApiClientCreatedDto;
    bot = await key(`Documents ${tag}`);
    other = await key(`Documents other ${tag}`);
    await first.close();
    const identity = {
      CS_APPROVE_CONFIRMS_ENABLED: true,
      BILLING_AUTO_APPROVE_ENABLED: true,
      CS_CUSTOMER_IDENTITY_ENABLED: true,
      CS_CUSTOMER_IDENTITY_COMPANY_ID: `docs-${randomUUID()}`,
      CS_CUSTOMER_IDENTITY_CLIENTS: JSON.stringify(
        Object.fromEntries(
          [bot, other].map((k) => [
            k.client.id,
            { secret, accounts: [{ channel: 'TELEGRAM', channelAccountId: 'test-bot' }] },
          ]),
        ),
      ),
      PUBLIC_WEB_URL: 'https://nolon.test',
      PDF_RENDERER_URL: `http://127.0.0.1:${port}`,
    };
    on = await createTestApp({ ...identity, CS_DOCUMENTS_ENABLED: true });
    off = await createTestApp({ ...identity, CS_DOCUMENTS_ENABLED: false });

    const countryCode = `T${String.fromCharCode(65 + randomInt(26))}`;
    for (const [name, suffix] of [
      ['origin', 'ORG'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await on.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Docs ${tag}${suffix}`,
            nameAr: 'مكان اختبار المستندات',
            countryCode,
          },
        })
      ).id;
    }
    route.originId = ids.origin!;
    route.destinationId = ids.dest!;
    await on
      .http()
      .put(`/api/v1/master-data/locations/${ids.origin}/routing-branches`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.admin)
      .send({ branchIds: [pts] })
      .expect(200);
    category = `${tag}B`;
    await on.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'BARREL',
        defaultUnit: 'PER_BARREL',
      },
    });
    await on.prisma.rateCard.create({
      data: {
        branchId: pts,
        originLocationId: ids.origin!,
        destinationLocationId: ids.dest!,
        mode: 'ROAD',
        cargoType: 'BARREL',
        priceCategoryCode: category,
        chargeTypeCode: 'FREIGHT',
        unit: 'PER_BARREL',
        price: '10',
        currency: 'USD',
        validFrom: new Date(Date.now() - 30 * 86_400_000),
        status: 'APPROVED',
        createdById: sales.id,
        approvedById: sales.id,
        approvedAt: new Date(),
      },
    });
    ids.warehouse = (
      (
        await staff(cookies.admin)
          .post('/warehouses', {
            branchId: pts,
            code: `${tag}W`,
            nameEn: `Store ${tag}`,
            nameAr: `مستودع ${tag}`,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    cash = (
      await staff(cookies.admin)
        .post('/accounting/accounts', {
          code: `${tag}C`,
          nameEn: `Cash ${tag}`,
          nameAr: 'نقدية اختبار',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency: 'USD',
          branchId: pts,
        })
        .expect(201)
    ).body as AccountDto;
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
    await new Promise<void>((resolve) => renderer.close(() => resolve()));
  });

  it('gives the waybill once the goods are received and a receipt per payment, each rendered at download', async () => {
    const { id, subjectId, shipmentId } = await approvedRequest();
    // Approved, nothing handed over yet.
    expect((await read(on, id, subjectId)).documents).toEqual({ waybill: null, receipts: [] });
    // The key alone (X-Cs-Sender) proves nothing: no links.
    expect((await read(on, id, subjectId, true)).documents).toBeNull();

    await receive(shipmentId);
    const received = (await read(on, id, subjectId)).documents!;
    expect(received.waybill?.url).toMatch(
      /^https:\/\/nolon\.test\/api\/v1\/cs\/documents\/[A-Za-z0-9_-]{43}$/,
    );
    expect(received.receipts).toEqual([]);
    const shipment = await on.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    const waybill = await asBot(on, pathOf(received.waybill!.url), subjectId).expect(200);
    expect(waybill.headers['content-type']).toBe('application/pdf');
    expect(waybill.headers['content-disposition']).toBe(
      `attachment; filename="waybill-${shipment.number}.pdf"`,
    );
    expect(waybill.headers['cache-control']).toBe('no-store');
    expect(rendered).toContain(shipment.number);
    expect(rendered).toContain('بوليصة الشحن');
    // The sender's name is text, never markup; the waybill carries no price.
    expect(rendered).not.toContain('<script>x');
    expect(rendered).toContain('&lt;script&gt;');

    const receipt = await pay(shipmentId, '25');
    const paid = (await read(on, id, subjectId)).documents!;
    expect(paid.receipts).toEqual([
      expect.objectContaining({ number: receipt.number, amount: '25', currency: 'USD' }),
    ]);
    await asBot(on, pathOf(paid.receipts[0]!.url), subjectId).expect(200);
    expect(rendered).toContain(receipt.number);
    expect(rendered).toContain('إيصال استلام نقدية');
    const log = await on.prisma.csAccessEvent.findMany({
      where: { apiClientId: bot.client.id, route: 'GET /cs/documents/:token' },
    });
    expect(log.filter((l) => l.outcome === 'OK')).toHaveLength(2);
  });

  it('refuses the key alone, another sender, another key, an expired link and the switch off', async () => {
    const { id, subjectId, shipmentId } = await approvedRequest();
    await receive(shipmentId);
    const url = (await read(on, id, subjectId)).documents!.waybill!.url;
    const path = pathOf(url);
    const refused = await asBot(on, path, subjectId, bot, true).expect(403);
    expect(refused.body).toMatchObject({ code: 'OWNER_PROOF_REQUIRED' });
    await asBot(on, path, `${subjectId}9`).expect(404);
    await asBot(on, path, subjectId, other).expect(404);
    await asBot(off, path, subjectId).expect(404);
    // Off: the read gives no links at all.
    expect((await read(off, id, subjectId)).documents).toBeNull();
    await asBot(on, '/api/v1/cs/documents/not-a-real-token-at-all', subjectId).expect(404);
    await on.prisma.csDocumentLink.updateMany({
      where: { requestId: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await asBot(on, path, subjectId).expect(410);
  });

  it('withdraws the waybill when its goods receipt is cancelled, and a receipt once cancelled', async () => {
    const { id, subjectId, shipmentId } = await approvedRequest();
    await receive(shipmentId);
    const receipt = await pay(shipmentId, '40');
    const docs = (await read(on, id, subjectId)).documents!;
    const movement = await on.prisma.warehouseMovement.findFirstOrThrow({ where: { shipmentId } });
    await on.prisma.warehouseMovementCancellation.create({
      data: { movementId: movement.id, branchId: pts, reason: 'test', cancelledById: ids.sales! },
    });
    await asBot(on, pathOf(docs.waybill!.url), subjectId).expect(404);
    expect((await read(on, id, subjectId)).documents?.waybill).toBeNull();
    await staff(cookies.admin)
      .post(`/receipts/${receipt.id}/cancel`, { reason: 'test' })
      .expect(200);
    await asBot(on, pathOf(docs.receipts[0]!.url), subjectId).expect(404);
    expect((await read(on, id, subjectId)).documents?.receipts).toEqual([]);
  });
  it('refuses a receipt of a branch the key does not serve, and every document once the key loses the branch', async () => {
    const { id, subjectId, shipmentId } = await approvedRequest();
    await receive(shipmentId);
    const receipt = await pay(shipmentId, '10');
    const docs = (await read(on, id, subjectId)).documents!;
    expect(docs.receipts).toHaveLength(1);
    // The receipt moved to a branch the key does not serve: its link is refused.
    const dxb = await branchId(on.prisma, 'DXB');
    await on.prisma.receipt.update({ where: { id: receipt.id }, data: { branchId: dxb } });
    await asBot(on, pathOf(docs.receipts[0]!.url), subjectId).expect(404);
    await on.prisma.receipt.update({ where: { id: receipt.id }, data: { branchId: pts } });
    await asBot(on, pathOf(docs.receipts[0]!.url), subjectId).expect(200);
    // The key now serves DXB only: the request's branch is no longer its own, both links refused.
    await on.prisma.apiClientBranch.create({ data: { apiClientId: bot.client.id, branchId: dxb } });
    await on.prisma.apiClientBranch.delete({
      where: { apiClientId_branchId: { apiClientId: bot.client.id, branchId: pts } },
    });
    try {
      await asBot(on, pathOf(docs.waybill!.url), subjectId).expect(404);
      await asBot(on, pathOf(docs.receipts[0]!.url), subjectId).expect(404);
    } finally {
      await on.prisma.apiClientBranch.create({
        data: { apiClientId: bot.client.id, branchId: pts },
      });
      await on.prisma.apiClientBranch.delete({
        where: { apiClientId_branchId: { apiClientId: bot.client.id, branchId: dxb } },
      });
    }
  });

  it('keeps only live links: expired ones of the request are pruned when new ones are issued', async () => {
    const { id, subjectId, shipmentId } = await approvedRequest();
    await receive(shipmentId);
    await read(on, id, subjectId);
    await on.prisma.csDocumentLink.updateMany({
      where: { requestId: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await read(on, id, subjectId);
    const rows = await on.prisma.csDocumentLink.findMany({ where: { requestId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
