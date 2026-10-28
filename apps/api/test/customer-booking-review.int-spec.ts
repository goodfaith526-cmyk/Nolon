import { randomInt, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  CsBookingRequestCreated,
  CsBookingRequestDto,
  CsBookingRequestStaffDto,
  CsBookingRequestSummaryDto,
  CsQuoteDto,
  CsRejectReasonDto,
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

/**
 * Staff review of the shipping bot's booking requests (plan 04a, R3-ج1): the list and a request
 * for the branches a person holds cs_booking_requests in; routing a request awaiting routing to
 * one of its branches; rejection with an approved reason, which is all the bot reads of it; the
 * reasons as audited master data; and the advisory check of a request's quote. Negative cases:
 * another branch, a missing permission, a stale version, a decided or expired request, an
 * inactive reason, and a key that no longer serves the branch.
 */
describe('Customer Service booking request review (R3c1)', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  let bot: ApiClientCreatedDto;
  const cookies = { admin: '', salesPts: '', salesJed: '', ops: '', finance: '' };
  const ids: Record<string, string> = {};
  let category = '';
  let cardId = '';

  const staff = (cookie: string) => ({
    get: (path: string) => t.http().get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    put: (path: string, body: object) =>
      t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  const sender = () => ({ channel: 'whatsapp', id: uniquePhone() });

  /** A request from the bot, by ids; returns its id and its sender (to read it back). */
  async function request(origin: string, extra: object = {}) {
    const from = sender();
    const made = (
      await t
        .http()
        .post('/api/v1/cs/booking-requests')
        .set('Authorization', `Bearer ${bot.key}`)
        .send({
          sender: from,
          originId: origin,
          destinationId: ids.dest,
          category,
          quantity: '2',
          services: [],
          senderName: 'Sender',
          consigneeName: 'Consignee',
          consigneePhone: '0912345678',
          handover: 'PICKUP',
          language: 'ar',
          idempotencyKey: `review-${randomUUID()}`,
          ...extra,
        })
        .expect(201)
    ).body as CsBookingRequestCreated;
    return { id: made.requestId, header: `whatsapp:${from.id}` };
  }
  const botRead = (id: string, header: string) =>
    t
      .http()
      .get(`/api/v1/cs/booking-requests/${id}`)
      .set('Authorization', `Bearer ${bot.key}`)
      .set('X-Cs-Sender', header);
  const detail = async (cookie: string, id: string) =>
    (await staff(cookie).get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const user = async (roles: Parameters<typeof createUser>[1], branches: string[]) =>
      createUser(t.prisma, roles, branches, LEDGER_PREFIX);
    const admin = await user(['ADMINISTRATOR'], []);
    cookies.admin = await signIn(t, admin.email);
    const salesPts = await user(['SALES'], ['PTS']);
    cookies.salesPts = await signIn(t, salesPts.email);
    cookies.salesJed = await signIn(t, (await user(['SALES'], ['JED'])).email);
    cookies.ops = await signIn(t, (await user(['OPERATIONS'], ['PTS'])).email);
    cookies.finance = await signIn(t, (await user(['FINANCE'], ['PTS'])).email);
    bot = (
      await staff(cookies.admin)
        .post('/api-clients', {
          name: 'Review',
          branchIds: [pts, jed],
          scopes: ['cs:booking_requests:create', 'cs:quote:read'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;

    const tag = `V${randomUUID().slice(0, 5).toUpperCase()}`;
    category = `${tag}S`;
    await t.prisma.priceCategory.create({
      data: {
        code: category,
        nameEn: category,
        nameAr: category,
        cargoType: 'GENERAL',
        defaultUnit: 'PER_SHIPMENT',
      },
    });
    const countryCode = `T${String.fromCharCode(65 + randomInt(26))}`;
    for (const [name, suffix] of [
      ['served', 'SRV'],
      ['two', 'TWO'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Review ${tag}${suffix}`,
            nameAr: 'مكان اختبار المراجعة',
            countryCode,
          },
        })
      ).id;
    }
    await staff(cookies.admin)
      .put(`/master-data/locations/${ids.served}/routing-branches`, { branchIds: [pts] })
      .expect(200);
    await staff(cookies.admin)
      .put(`/master-data/locations/${ids.two}/routing-branches`, { branchIds: [pts, jed] })
      .expect(200);
    cardId = (
      await t.prisma.rateCard.create({
        data: {
          branchId: pts,
          originLocationId: ids.served!,
          destinationLocationId: ids.dest!,
          mode: 'ROAD',
          cargoType: 'GENERAL',
          chargeTypeCode: 'FREIGHT',
          unit: 'PER_SHIPMENT',
          price: '40',
          currency: 'USD',
          validFrom: new Date(Date.now() - 30 * 86_400_000),
          status: 'APPROVED',
          createdById: salesPts.id,
          approvedById: salesPts.id,
          approvedAt: new Date(),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await t.close();
  });

  it('lists a branch’s requests to those who hold the permission there only', async () => {
    const pending = await request(ids.served!);
    const awaiting = await request(ids.two!);
    const listed = async (cookie: string) =>
      (
        (await staff(cookie).get('/cs-booking-requests').expect(200))
          .body as CsBookingRequestSummaryDto[]
      ).map((r) => r.id);

    expect(await listed(cookies.salesPts)).toEqual(
      expect.arrayContaining([pending.id, awaiting.id]),
    );
    // JED's Sales see the request awaiting routing (JED may take it), not PTS's pending one.
    const jedSees = await listed(cookies.salesJed);
    expect(jedSees).toContain(awaiting.id);
    expect(jedSees).not.toContain(pending.id);
    await staff(cookies.salesJed).get(`/cs-booking-requests/${pending.id}`).expect(404);
    // Operations view only: the branch's pending request, never one awaiting routing.
    const opsSees = await listed(cookies.ops);
    expect(opsSees).toContain(pending.id);
    expect(opsSees).not.toContain(awaiting.id);
    expect((await detail(cookies.ops, pending.id)).actions).toEqual({
      canRoute: false,
      canReject: false,
    });
    // Finance holds no part of it.
    await staff(cookies.finance).get('/cs-booking-requests').expect(403);

    const shown = await detail(cookies.salesPts, awaiting.id);
    expect(shown).toMatchObject({
      status: 'awaiting_routing',
      branchId: null,
      allowedBranchIds: [pts, jed].sort(),
      consigneePhone: '0912345678',
      botNames: null,
      botQuotedPrice: null,
      internalNote: null,
      actions: { canRoute: true, canReject: true },
    });
  });

  it('routes a request awaiting routing to one of its branches, once', async () => {
    const awaiting = await request(ids.two!);
    const route = (cookie: string, body: object) =>
      staff(cookie).post(`/cs-booking-requests/${awaiting.id}/route`, body);
    const { version } = await detail(cookies.salesPts, awaiting.id);

    await route(cookies.ops, { version, branchId: pts }).expect(403);
    // PTS's Sales may not send it to JED, and nobody to a branch it may not go to.
    await route(cookies.salesPts, { version, branchId: jed }).expect(403);
    await route(cookies.admin, { version, branchId: randomUUID() }).expect(403);
    await route(cookies.salesPts, { version: version + 1, branchId: pts }).expect(409);

    const routed = (await route(cookies.salesPts, { version, branchId: pts }).expect(201))
      .body as CsBookingRequestStaffDto;
    expect(routed).toMatchObject({ status: 'pending', branchId: pts, version: version + 1 });
    expect(routed.routedAt).not.toBeNull();
    await route(cookies.salesPts, { version: version + 1, branchId: pts }).expect(409);
    // Now PTS's: JED's Sales no longer see it.
    await staff(cookies.salesJed).get(`/cs-booking-requests/${awaiting.id}`).expect(404);
    expect(
      ((await botRead(awaiting.id, awaiting.header).expect(200)).body as CsBookingRequestDto)
        .status,
    ).toBe('pending');
  });

  it('rejects with an active approved reason, which is all the bot reads of it', async () => {
    const pending = await request(ids.served!);
    const reject = (cookie: string, body: object) =>
      staff(cookie).post(`/cs-booking-requests/${pending.id}/reject`, body);
    const { version } = await detail(cookies.salesPts, pending.id);

    await reject(cookies.ops, { version, reasonCode: 'NEED_MORE_INFO' }).expect(403);
    await reject(cookies.salesJed, { version, reasonCode: 'NEED_MORE_INFO' }).expect(404);
    await reject(cookies.salesPts, { version, reasonCode: 'NO_SUCH' }).expect(409);
    await reject(cookies.salesPts, { version, reasonCode: 'bad code' }).expect(400);
    await reject(cookies.salesPts, { version: version + 1, reasonCode: 'DUPLICATE' }).expect(409);

    const done = (
      await reject(cookies.salesPts, {
        version,
        reasonCode: 'NEED_MORE_INFO',
        internalNote: 'Customer did not answer',
      }).expect(201)
    ).body as CsBookingRequestStaffDto;
    expect(done).toMatchObject({
      status: 'rejected',
      rejectReasonCode: 'NEED_MORE_INFO',
      internalNote: 'Customer did not answer',
      actions: { canRoute: false, canReject: false },
    });
    await reject(cookies.salesPts, { version: version + 1, reasonCode: 'DUPLICATE' }).expect(409);

    const seen = (await botRead(pending.id, pending.header).expect(200))
      .body as CsBookingRequestDto;
    expect(seen).toMatchObject({
      status: 'rejected',
      customerReason: {
        ar: 'محتاجين معلومات أكتر، حنتواصل معاك',
        en: 'We need more information and will contact you',
      },
    });
    expect(JSON.stringify(seen)).not.toContain('Customer did not answer');

    // One awaiting routing is rejected for the rejecting person's branch.
    const awaiting = await request(ids.two!);
    const v = (await detail(cookies.salesJed, awaiting.id)).version;
    const byJed = (
      await staff(cookies.salesJed)
        .post(`/cs-booking-requests/${awaiting.id}/reject`, { version: v, reasonCode: 'DUPLICATE' })
        .expect(201)
    ).body as CsBookingRequestStaffDto;
    expect(byJed).toMatchObject({ status: 'rejected', branchId: jed });
  });

  it('refuses an expired request, and a key that no longer serves the branch', async () => {
    const expired = await request(ids.served!);
    await t.prisma.csBookingRequest.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await detail(cookies.salesPts, expired.id);
    expect(late).toMatchObject({ status: 'expired', actions: { canReject: false } });
    await staff(cookies.salesPts)
      .post(`/cs-booking-requests/${expired.id}/reject`, {
        version: late.version,
        reasonCode: 'DUPLICATE',
      })
      .expect(409);

    const narrowKey = (
      await staff(cookies.admin)
        .post('/api-clients', {
          name: 'Review narrow',
          branchIds: [pts, jed],
          scopes: ['cs:booking_requests:create'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;
    const made = (
      await t
        .http()
        .post('/api/v1/cs/booking-requests')
        .set('Authorization', `Bearer ${narrowKey.key}`)
        .send({
          sender: sender(),
          originId: ids.two,
          destinationId: ids.dest,
          category,
          quantity: '1',
          services: [],
          senderName: 'S',
          consigneeName: 'C',
          consigneePhone: '0912345678',
          handover: 'PICKUP',
          language: 'ar',
          idempotencyKey: `review-${randomUUID()}`,
        })
        .expect(201)
    ).body as CsBookingRequestCreated;
    await t.prisma.apiClientBranch.delete({
      where: { apiClientId_branchId: { apiClientId: narrowKey.client.id, branchId: pts } },
    });
    const { version } = await detail(cookies.salesPts, made.requestId);
    await staff(cookies.salesPts)
      .post(`/cs-booking-requests/${made.requestId}/route`, { version, branchId: pts })
      .expect(409);
  });

  it('keeps the reasons as audited master data the Administrator changes', async () => {
    const list = async () =>
      (
        (await staff(cookies.salesPts).get('/cs-booking-requests/reject-reasons').expect(200))
          .body as CsRejectReasonDto[]
      ).map((r) => r.code);
    expect(await list()).toEqual(
      expect.arrayContaining(['ROUTE_UNAVAILABLE', 'NEED_MORE_INFO', 'DUPLICATE']),
    );
    const code = `R${randomUUID().slice(0, 8).toUpperCase().replaceAll('-', '')}`;
    const body = { textAr: 'سبب تجربة', textEn: 'A test reason', isActive: true };
    await staff(cookies.salesPts).put(`/cs-reject-reasons/${code}`, body).expect(403);
    await staff(cookies.admin).put('/cs-reject-reasons/bad code', body).expect(400);
    await staff(cookies.admin).put(`/cs-reject-reasons/${code}`, body).expect(200);
    await staff(cookies.admin)
      .put(`/cs-reject-reasons/${code}`, { ...body, isActive: false })
      .expect(200);
    const audit = await t.prisma.auditEvent.findMany({
      where: { entity: 'CS_REJECT_REASON', reference: code },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['CREATED', 'UPDATED']);
    expect(audit[1]?.changes).toEqual([{ field: 'isActive', before: 'true', after: 'false' }]);

    // An inactive reason is refused.
    const pending = await request(ids.served!);
    const { version } = await detail(cookies.salesPts, pending.id);
    await staff(cookies.salesPts)
      .post(`/cs-booking-requests/${pending.id}/reject`, { version, reasonCode: code })
      .expect(409);
  });

  it('shows a request awaiting routing where the person may only route it (F131-1)', async () => {
    const OWNER = '00000000-0000-0000-0000-000000000000';
    const grant = async (
      userId: string,
      branch: string,
      permission: string,
      effect: 'ALLOW' | 'DENY',
    ) =>
      t.prisma.userBranchPermission.create({
        data: {
          userId,
          branchId: branch,
          permission,
          effect,
          sourceKey: OWNER,
          createdById: userId,
        },
      });
    // Operations in both branches: VIEW in JED only, and in PTS routing without viewing.
    const router = await createUser(t.prisma, ['OPERATIONS'], ['PTS', 'JED'], LEDGER_PREFIX);
    await grant(router.id, pts, 'cs_booking_requests:update', 'ALLOW');
    await grant(router.id, pts, 'cs_booking_requests:view', 'DENY');
    // Finance holds nothing of it but routing in PTS.
    const onlyRoute = await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX);
    await grant(onlyRoute.id, pts, 'cs_booking_requests:update', 'ALLOW');
    await t.prisma.accessState.update({ where: { id: 1 }, data: { version: { increment: 1 } } });
    const routerCookie = await signIn(t, router.email);
    const onlyRouteCookie = await signIn(t, onlyRoute.email);

    const awaiting = await request(ids.two!);
    const pending = await request(ids.served!);
    const listed = async (cookie: string) =>
      (
        (await staff(cookie).get('/cs-booking-requests').expect(200))
          .body as CsBookingRequestSummaryDto[]
      ).map((r) => r.id);
    for (const cookie of [routerCookie, onlyRouteCookie]) {
      const seen = await listed(cookie);
      expect(seen).toContain(awaiting.id);
      // A pending request of PTS stays closed to them: no VIEW there.
      expect(seen).not.toContain(pending.id);
      await staff(cookie).get(`/cs-booking-requests/${pending.id}`).expect(404);
    }
    const shown = await detail(routerCookie, awaiting.id);
    expect(shown.actions).toMatchObject({ canRoute: true, canReject: false });

    const routed = (
      await staff(routerCookie)
        .post(`/cs-booking-requests/${awaiting.id}/route`, {
          version: shown.version,
          branchId: pts,
        })
        .expect(201)
    ).body as CsBookingRequestStaffDto;
    expect(routed).toMatchObject({ id: awaiting.id, status: 'pending', branchId: pts });
    // Routed to PTS, where they do not view: it is no longer theirs to open.
    await staff(routerCookie).get(`/cs-booking-requests/${awaiting.id}`).expect(404);
    expect(await listed(routerCookie)).not.toContain(awaiting.id);
    // Nobody without any part of the review reaches it.
    await staff(cookies.finance).get('/cs-booking-requests').expect(403);
    await staff(cookies.finance).get('/cs-booking-requests/reject-reasons').expect(403);
  });

  it('keeps a request readable when its quote’s currency is deactivated (F131-2)', async () => {
    const code = `Q${String.fromCharCode(65 + randomInt(26))}${String.fromCharCode(65 + randomInt(26))}`;
    await t.prisma.currency.upsert({
      where: { code },
      create: { code, nameEn: `Test ${code}`, nameAr: `تجربة ${code}`, decimalPlaces: 2 },
      update: { isActive: true },
    });
    const approver = (await t.prisma.rateCard.findUniqueOrThrow({ where: { id: cardId } }))
      .createdById;
    const extra: string[] = [];
    for (const origin of [ids.served!, ids.two!]) {
      const card = await t.prisma.rateCard.create({
        data: {
          branchId: pts,
          originLocationId: origin,
          destinationLocationId: ids.dest!,
          mode: 'ROAD',
          cargoType: 'GENERAL',
          chargeTypeCode: 'FREIGHT',
          unit: 'PER_SHIPMENT',
          price: '10',
          currency: code,
          validFrom: new Date(Date.now() - 86_400_000),
          status: 'APPROVED',
          createdById: approver,
          approvedById: approver,
          approvedAt: new Date(),
        },
      });
      extra.push(card.id);
    }
    const quoted = async (origin: string) => {
      const quote = (
        await t
          .http()
          .get('/api/v1/cs/quote')
          .query({
            originId: origin,
            destinationId: ids.dest,
            category,
            quantity: '2',
            currency: code,
          })
          .set('Authorization', `Bearer ${bot.key}`)
          .expect(200)
      ).body as CsQuoteDto;
      return request(origin, { quoteRef: quote.quoteRef });
    };
    const pending = await quoted(ids.served!);
    const awaiting = await quoted(ids.two!);
    await t.prisma.currency.update({ where: { code }, data: { isActive: false } });

    const shown = await detail(cookies.salesPts, pending.id);
    expect(shown.priceCheck).toMatchObject({ state: 'stale', currency: code, totalNow: null });
    const rejected = (
      await staff(cookies.salesPts)
        .post(`/cs-booking-requests/${pending.id}/reject`, {
          version: shown.version,
          reasonCode: 'ROUTE_UNAVAILABLE',
        })
        .expect(201)
    ).body as CsBookingRequestStaffDto;
    expect(rejected).toMatchObject({ status: 'rejected', priceCheck: { state: 'stale' } });

    const waiting = await detail(cookies.salesPts, awaiting.id);
    const routed = (
      await staff(cookies.salesPts)
        .post(`/cs-booking-requests/${awaiting.id}/route`, {
          version: waiting.version,
          branchId: pts,
        })
        .expect(201)
    ).body as CsBookingRequestStaffDto;
    expect(routed).toMatchObject({ status: 'pending', priceCheck: { state: 'stale' } });
    // The other tests quote without a currency.
    await t.prisma.rateCard.updateMany({
      where: { id: { in: extra } },
      data: { status: 'CANCELLED' },
    });
  });

  it('checks the quote of a request again when staff open it', async () => {
    const quote = (
      await t
        .http()
        .get('/api/v1/cs/quote')
        .query({ originId: ids.served, destinationId: ids.dest, category, quantity: '2' })
        .set('Authorization', `Bearer ${bot.key}`)
        .expect(200)
    ).body as CsQuoteDto;
    const made = await request(ids.served!, { quoteRef: quote.quoteRef });
    expect((await detail(cookies.salesPts, made.id)).priceCheck).toMatchObject({
      state: 'current',
      rateCardId: cardId,
      currency: 'USD',
      quotedTotal: quote.total,
      totalNow: quote.total,
    });
    await t.prisma.rateCard.update({ where: { id: cardId }, data: { status: 'CANCELLED' } });
    try {
      expect((await detail(cookies.salesPts, made.id)).priceCheck).toMatchObject({
        state: 'stale',
        quotedTotal: quote.total,
        totalNow: null,
      });
    } finally {
      await t.prisma.rateCard.update({ where: { id: cardId }, data: { status: 'APPROVED' } });
    }
  });
});
