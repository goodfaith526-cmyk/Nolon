import { randomInt, randomUUID } from 'node:crypto';
import type {
  AlertsDto,
  ApiClientCreatedDto,
  CustomerInvoiceDto,
  ShipmentCustomsDto,
  BookingDto,
  CsApprovalPriceDto,
  CsBookingRequestCreated,
  CsBookingRequestStaffDto,
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
import { BookingsService } from '../src/bookings/bookings.service.js';
import { uniquePhone } from './test-data.js';

/**
 * Plan 12 section 2: the shipment's invoice made when its booking is confirmed. Approved by the
 * system only at the agreed price whose terms still match (AGREED_PRICE), or at rate card prices
 * for a confirmer who may approve invoices (RATE_CARD_WITH_RIGHT), with the switch on; otherwise a
 * draft that says why. Negative cases: terms changed after the agreement, no right to approve, the
 * switch off, a closed period, the invoice taking the balance over the credit limit (a draft) and
 * the balance already over it (the whole confirmation refused). Approved invoices post entries, so
 * the users are LEDGER users and every customer is this run's own.
 */
describe('automatic invoice on booking confirmation (plan 12 section 2)', () => {
  let t: TestApp;
  let off: TestApp;
  let pts = '';
  let bot: ApiClientCreatedDto;
  const cookies = { admin: '', sales: '', approver: '' };
  const userIds = { sales: '', approver: '' };
  const ids: Record<string, string> = {};
  const cat = { barrel: '', box: '', cbm: '' };
  const tag = `A${randomUUID().slice(0, 5).toUpperCase()}`;

  const staff = (cookie: string, app = () => t) => ({
    get: (path: string, query: object = {}) =>
      app().http().get(`/api/v1${path}`).query(query).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      app()
        .http()
        .post(`/api/v1${path}`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send(body),
    patch: (path: string, body: object = {}) =>
      app()
        .http()
        .patch(`/api/v1${path}`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send(body),
    delete: (path: string) =>
      app().http().delete(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie),
  });
  const route = { originId: '', destinationId: '', mode: 'ROAD', currency: 'USD' };

  async function newCustomer(limit: string | null = null): Promise<string> {
    return (
      await t.prisma.customer.create({
        data: {
          number: `${tag}-${randomUUID().slice(0, 6)}`,
          name: `${tag} customer`,
          phone: uniquePhone(),
          kind: 'COMPANY',
          preferredCurrency: 'USD',
          createdById: userIds.sales,
          ...(limit === null ? {} : { creditLimit: limit, creditLimitCurrency: 'USD' }),
        },
      })
    ).id;
  }

  /** A bot request of 3 barrels (30) and 2 boxes (10), approved for `customerId`: total 40. */
  async function agreedBooking(customerId: string): Promise<CsBookingRequestStaffDto> {
    const made = (
      await t
        .http()
        .post('/api/v1/cs/booking-requests')
        .set('Authorization', `Bearer ${bot.key}`)
        .send({
          sender: { channel: 'whatsapp', id: uniquePhone() },
          originId: ids.origin,
          destinationId: ids.dest,
          services: [],
          senderName: 'Sender',
          consigneeName: 'Consignee',
          consigneePhone: '0912345678',
          handover: 'PICKUP',
          language: 'ar',
          idempotencyKey: `auto-${randomUUID()}`,
          items: [
            { category: cat.barrel, quantity: '3' },
            { category: cat.box, quantity: '2' },
          ],
        })
        .expect(201)
    ).body as CsBookingRequestCreated;
    const id = made.requestId;
    const sales = staff(cookies.sales);
    const lines = [];
    for (const [category, quantity] of [
      [cat.barrel, '3'],
      [cat.box, '2'],
    ] as const) {
      const price = (
        await sales
          .get(`/cs-booking-requests/${id}/price`, { ...route, category, quantity })
          .expect(200)
      ).body as CsApprovalPriceDto;
      lines.push({ category, quantity, pricingFingerprint: price.pricingFingerprint });
    }
    const detail = (await sales.get(`/cs-booking-requests/${id}`).expect(200))
      .body as CsBookingRequestStaffDto;
    const approved = (
      await sales
        .post(`/cs-booking-requests/${id}/approve`, {
          version: detail.version,
          paymentCurrency: 'USD',
          pricing: route,
          lines,
          booking: { customerId, services: [] },
        })
        .expect(201)
    ).body as CsBookingRequestStaffDto;
    expect(approved.approvedPricing?.total).toBe('40');
    return approved;
  }

  /** A staff booking of 2 CBM at the rate card's 100 per CBM: 200. */
  async function cardBooking(
    customerId: string,
    services: string[] = ['MAIN_FREIGHT'],
  ): Promise<string> {
    return (
      (
        await staff(cookies.sales)
          .post('/bookings', {
            customerId,
            originLocationId: ids.origin,
            destinationLocationId: ids.dest,
            mode: 'ROAD',
            cargoType: 'GENERAL',
            services,
            items: [
              {
                cargoType: 'GENERAL',
                priceCategoryCode: cat.cbm,
                quantity: 1,
                volumeCbm: '2',
                weightKg: '10',
              },
            ],
          })
          .expect(201)
      ).body as BookingDto
    ).id;
  }

  const confirm = (bookingId: string, cookie = cookies.sales, app = () => t) =>
    staff(cookie, app).post(`/bookings/${bookingId}/confirm`);
  async function invoicesOf(bookingId: string) {
    const shipment = await t.prisma.shipment.findUniqueOrThrow({ where: { bookingId } });
    return t.prisma.customerInvoice.findMany({
      where: { shipmentId: shipment.id },
      include: { lines: true },
      orderBy: { createdAt: 'asc' },
    });
  }
  async function onlyInvoice(bookingId: string) {
    const all = await invoicesOf(bookingId);
    expect(all).toHaveLength(1);
    return all[0]!;
  }

  beforeAll(async () => {
    t = await createTestApp({ BILLING_AUTO_APPROVE_ENABLED: true });
    off = await createTestApp({ BILLING_AUTO_APPROVE_ENABLED: false });
    pts = await branchId(t.prisma, 'PTS');
    const user = async (roles: Parameters<typeof createUser>[1], branches: string[]) =>
      createUser(t.prisma, roles, branches, LEDGER_PREFIX);
    cookies.admin = await signIn(t, (await user(['ADMINISTRATOR'], [])).email);
    const sales = await user(['SALES'], ['PTS']);
    userIds.sales = sales.id;
    cookies.sales = await signIn(t, sales.email);
    // Sales staff who also approve invoices (Finance) in the branch.
    const approver = await user(['SALES', 'FINANCE'], ['PTS']);
    userIds.approver = approver.id;
    cookies.approver = await signIn(t, approver.email);
    bot = (
      await staff(cookies.admin)
        .post('/api-clients', {
          name: 'Auto invoice',
          branchIds: [pts],
          scopes: ['cs:booking_requests:create', 'cs:quote:read'],
        })
        .expect(201)
    ).body as ApiClientCreatedDto;

    const countryCode = `T${String.fromCharCode(65 + randomInt(26))}`;
    for (const [name, suffix] of [
      ['origin', 'ORG'],
      ['dest', 'DES'],
    ] as const) {
      ids[name] = (
        await t.prisma.location.create({
          data: {
            code: `${tag}${suffix}`,
            kind: 'CITY',
            nameEn: `Auto ${tag}${suffix}`,
            nameAr: 'مكان اختبار الفاتورة التلقائية',
            countryCode,
          },
        })
      ).id;
    }
    route.originId = ids.origin!;
    route.destinationId = ids.dest!;
    await t
      .http()
      .put(`/api/v1/master-data/locations/${ids.origin}/routing-branches`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.admin)
      .send({ branchIds: [pts] })
      .expect(200);
    // The freight charge of this run, under the main freight service the bookings carry.
    const freight = `${tag}F`;
    await t.prisma.chargeType.create({
      data: { code: freight, nameEn: freight, nameAr: 'شحن اختبار', service: 'MAIN_FREIGHT' },
    });
    for (const [key, suffix, cargoType, unit, price] of [
      ['barrel', 'B', 'BARREL', 'PER_BARREL', '10'],
      ['box', 'X', 'GENERAL', 'PER_PIECE', '5'],
      ['cbm', 'C', 'GENERAL', 'PER_CBM', '100'],
    ] as const) {
      const code = `${tag}${suffix}`;
      cat[key] = code;
      await t.prisma.priceCategory.create({
        data: { code, nameEn: code, nameAr: code, cargoType, defaultUnit: unit },
      });
      await t.prisma.rateCard.create({
        data: {
          branchId: pts,
          originLocationId: ids.origin!,
          destinationLocationId: ids.dest!,
          mode: 'ROAD',
          cargoType,
          priceCategoryCode: code,
          // The bot prices FREIGHT; the staff booking's card is under a mapped charge.
          chargeTypeCode: key === 'cbm' ? freight : 'FREIGHT',
          unit,
          price,
          currency: 'USD',
          validFrom: new Date(Date.now() - 30 * 86_400_000),
          status: 'APPROVED',
          createdById: sales.id,
          approvedById: sales.id,
          approvedAt: new Date(),
        },
      });
    }
  });

  afterAll(async () => {
    await off?.close();
    await t?.close();
  });

  it('approves the agreed price of a bot request with several items, confirmed by sales staff', async () => {
    const customerId = await newCustomer();
    const approved = await agreedBooking(customerId);
    const bookingId = approved.bookingId!;
    // The agreement is a quotation of the request, its lines bound to the booking's lines.
    const booking = await t.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { quotation: { include: { lines: true } }, items: true },
    });
    expect(booking.quotation).toMatchObject({
      source: 'BOT_REQUEST',
      status: 'APPROVED',
      csRequestId: approved.id,
      currency: 'USD',
    });
    expect(booking.agreedTermsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(booking.agreedTermsVersion).toBe(1);
    expect(booking.quotation!.lines.map((l) => l.bookingItemId).sort()).toEqual(
      booking.items.map((i) => i.id).sort(),
    );

    await confirm(bookingId).expect(200);
    const invoice = await onlyInvoice(bookingId);
    expect(invoice).toMatchObject({
      status: 'APPROVED',
      approvalSource: 'AUTO_ON_CONFIRM',
      autoRule: 'AGREED_PRICE',
      autoInitiatedById: userIds.sales,
      approvedById: null,
      autoTermsHash: booking.agreedTermsHash,
      autoNote: null,
      currency: 'USD',
    });
    expect(invoice.total.toString()).toBe('40');
    expect(invoice.number).not.toBeNull();
    expect(invoice.journalEntryId).not.toBeNull();
    // Shown to staff with who confirmed and under which rule.
    const shown = (
      await staff(cookies.approver).get(`/customer-invoices/${invoice.id}`).expect(200)
    ).body as { autoApproval: unknown; autoNote: unknown };
    expect(shown.autoApproval).toMatchObject({ rule: 'AGREED_PRICE' });
    expect(shown.autoNote).toBeNull();
  });

  it('keeps a draft when the cargo changed after the agreement', async () => {
    const approved = await agreedBooking(await newCustomer());
    const bookingId = approved.bookingId!;
    const line = await t.prisma.bookingItem.findFirstOrThrow({ where: { bookingId } });
    await t.prisma.bookingItem.update({ where: { id: line.id }, data: { volumeCbm: '2' } });
    await confirm(bookingId).expect(200);
    const invoice = await onlyInvoice(bookingId);
    expect(invoice).toMatchObject({
      status: 'DRAFT',
      approvalSource: 'MANUAL',
      autoNote: 'AGREED_TERMS_CHANGED',
      number: null,
      journalEntryId: null,
    });
  });

  it('keeps a draft when the agreed quotation did not price the cargo booked (F193-1)', async () => {
    const approved = await agreedBooking(await newCustomer());
    const bookingId = approved.bookingId!;
    // The booking carries 4 barrels where 3 were priced, with the terms pinned on it as they are:
    // the hash matches, but the quotation does not price these goods.
    const barrels = await t.prisma.bookingItem.findFirstOrThrow({
      where: { bookingId, cargoType: 'BARREL' },
    });
    await t.prisma.bookingItem.update({ where: { id: barrels.id }, data: { quantity: 4 } });
    const bookings = t.app.get(BookingsService);
    await t.prisma.$transaction((tx) => bookings.pinAgreedTermsInTx(tx, bookingId));
    await confirm(bookingId, cookies.approver).expect(200);
    expect(await onlyInvoice(bookingId)).toMatchObject({
      status: 'DRAFT',
      autoNote: 'AGREED_PRICE_MISMATCH',
      number: null,
    });
  });

  it('keeps a draft when a booked service has no price (F193-2)', async () => {
    // Customs is booked, and no rate card prices it: the freight alone is not the invoice.
    const bookingId = await cardBooking(await newCustomer(), ['MAIN_FREIGHT', 'CUSTOMS']);
    await confirm(bookingId, cookies.approver).expect(200);
    expect(await onlyInvoice(bookingId)).toMatchObject({
      status: 'DRAFT',
      autoNote: 'PRICE_INCOMPLETE',
    });
  });

  it('approves rate card prices only for a confirmer who may approve invoices', async () => {
    const noRight = await cardBooking(await newCustomer());
    await confirm(noRight).expect(200);
    const draft = await onlyInvoice(noRight);
    expect(draft).toMatchObject({ status: 'DRAFT', autoNote: 'NO_APPROVE_RIGHT' });
    expect(draft.total.toString()).toBe('200');

    const withRight = await cardBooking(await newCustomer());
    await confirm(withRight, cookies.approver).expect(200);
    expect(await onlyInvoice(withRight)).toMatchObject({
      status: 'APPROVED',
      autoRule: 'RATE_CARD_WITH_RIGHT',
      approvedById: userIds.approver,
      autoInitiatedById: userIds.approver,
      autoTermsHash: null,
    });
  });

  it('keeps a draft with the switch off', async () => {
    const approved = await agreedBooking(await newCustomer());
    await confirm(approved.bookingId!, cookies.sales, () => off).expect(200);
    expect(await onlyInvoice(approved.bookingId!)).toMatchObject({
      status: 'DRAFT',
      autoNote: 'SWITCH_OFF',
    });
  });

  it('keeps a draft when the period is closed, and the booking is still confirmed', async () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const before = await t.prisma.fiscalPeriod.findUnique({
      where: { year_month: { year, month } },
    });
    const approved = await agreedBooking(await newCustomer());
    await t.prisma.fiscalPeriod.upsert({
      where: { year_month: { year, month } },
      create: {
        year,
        month,
        startDate: new Date(Date.UTC(year, month - 1, 1)),
        endDate: new Date(Date.UTC(year, month, 0)),
        status: 'CLOSED',
        closedAt: new Date(),
      },
      update: { status: 'CLOSED', closedAt: new Date() },
    });
    try {
      await confirm(approved.bookingId!).expect(200);
    } finally {
      if (before === null) {
        await t.prisma.fiscalPeriod.delete({ where: { year_month: { year, month } } });
      } else {
        await t.prisma.fiscalPeriod.update({
          where: { id: before.id },
          data: { status: before.status, closedAt: before.closedAt },
        });
      }
    }
    expect(await onlyInvoice(approved.bookingId!)).toMatchObject({
      status: 'DRAFT',
      autoNote: 'PERIOD_CLOSED',
      number: null,
      journalEntryId: null,
    });
    expect(
      (await t.prisma.booking.findUniqueOrThrow({ where: { id: approved.bookingId! } })).status,
    ).toBe('CONFIRMED');
  });

  it('keeps a draft when the invoice takes the balance over the limit; refuses the confirmation when the balance is already over it', async () => {
    const customerId = await newCustomer('50');
    // 40 of 50: approved.
    const first = await agreedBooking(customerId);
    await confirm(first.bookingId!).expect(200);
    expect((await onlyInvoice(first.bookingId!)).status).toBe('APPROVED');

    // Another 40 makes 80 over 50: the approval is rolled back to a draft, and the work after the
    // savepoint (the note, the credit check) still runs on the same transaction.
    const second = await agreedBooking(customerId);
    await confirm(second.bookingId!).expect(200);
    const draft = await onlyInvoice(second.bookingId!);
    expect(draft).toMatchObject({
      status: 'DRAFT',
      autoNote: 'CREDIT_LIMIT_EXCEEDED',
      approvalSource: 'MANUAL',
      autoRule: null,
      number: null,
      journalEntryId: null,
    });

    // The balance before (40) over a lowered limit of 30: the whole confirmation is refused.
    await t.prisma.customer.update({ where: { id: customerId }, data: { creditLimit: '30' } });
    const third = await agreedBooking(customerId);
    const refused = await confirm(third.bookingId!).expect(409);
    expect(refused.body).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED' });
    const row = await t.prisma.booking.findUniqueOrThrow({
      where: { id: third.bookingId! },
      include: { shipment: true },
    });
    expect(row.status).toBe('DRAFT');
    expect(row.shipment).toBeNull();
  });

  it('gives way to an invoice made by hand, and is cancelled with its shipment', async () => {
    const replaced = await cardBooking(await newCustomer());
    await confirm(replaced).expect(200);
    const auto = await onlyInvoice(replaced);
    const shipment = await t.prisma.shipment.findUniqueOrThrow({ where: { bookingId: replaced } });
    await staff(cookies.approver)
      .post('/customer-invoices', { shipmentId: shipment.id })
      .expect(201);
    const after = await invoicesOf(replaced);
    expect(after).toHaveLength(2);
    expect(after.find((i) => i.id === auto.id)?.status).toBe('CANCELLED');

    const cancelled = await cardBooking(await newCustomer());
    await confirm(cancelled).expect(200);
    const draft = await onlyInvoice(cancelled);
    const s = await t.prisma.shipment.findUniqueOrThrow({ where: { bookingId: cancelled } });
    await staff(cookies.admin)
      .post(`/shipments/${s.id}/cancel`, { reason: 'Customer withdrew' })
      .expect(200);
    expect(
      (await t.prisma.customerInvoice.findUniqueOrThrow({ where: { id: draft.id } })).status,
    ).toBe('CANCELLED');
  });
  it('offers the customs fees no invoice bills on the additional services invoice (section 5)', async () => {
    const bookingId = await cardBooking(await newCustomer());
    await confirm(bookingId, cookies.approver).expect(200);
    expect((await onlyInvoice(bookingId)).status).toBe('APPROVED');
    const shipment = await t.prisma.shipment.findUniqueOrThrow({ where: { bookingId } });
    const admin = staff(cookies.admin);
    const finance = staff(cookies.approver);
    for (const [description, amount] of [
      ['Duty', '30'],
      ['Inspection', '20'],
    ] as const) {
      await admin
        .post(`/shipments/${shipment.id}/customs/fees`, { description, amount, currency: 'USD' })
        .expect(201);
    }
    // Recorded two days ago and not invoiced: the shipment is listed.
    await t.prisma.customsFee.updateMany({
      where: { shipmentId: shipment.id },
      data: { createdAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    // Oldest first, as offered (one time now: then by id).
    const fees = await t.prisma.customsFee.findMany({
      where: { shipmentId: shipment.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const listed = async () =>
      ((await finance.get('/alerts').expect(200)).body as AlertsDto).groups
        .find((g) => g.kind === 'SHIPMENT_NOT_INVOICED')
        ?.items.some((a) => a.refId === shipment.id) ?? false;
    expect(await listed()).toBe(true);

    // One line per fee, under CUSTOMS, at its amount, linked to it.
    const extra = (
      await finance
        .post('/customer-invoices', { shipmentId: shipment.id, kind: 'ADDITIONAL' })
        .expect(201)
    ).body as CustomerInvoiceDto;
    expect(extra.currency).toBe('USD');
    expect(
      extra.lines.map((l) => [l.chargeTypeCode, l.description, l.unitPrice, l.customsFeeId]),
    ).toEqual(fees.map((f) => ['CUSTOMS', f.description, f.amount.toFixed(), f.id]));

    // On a live draft, a fee is not offered again, nor billed twice.
    const second = (
      await finance
        .post('/customer-invoices', { shipmentId: shipment.id, kind: 'ADDITIONAL' })
        .expect(201)
    ).body as CustomerInvoiceDto;
    expect(second.lines).toEqual([]);
    const body = (lines: object[]) => ({
      currency: 'USD',
      invoiceDate: extra.invoiceDate,
      dueDate: extra.dueDate,
      lines,
    });
    const feeLine = (id: string, amount: string) => ({
      chargeTypeCode: 'CUSTOMS',
      quantity: '1',
      unitPrice: amount,
      customsFeeId: id,
    });
    const taken = await finance
      .patch(`/customer-invoices/${second.id}`, body([feeLine(fees[0]!.id, '30')]))
      .expect(409);
    expect(taken.body).toMatchObject({ code: 'CUSTOMS_FEE_BILLED' });
    // Under another charge, or twice on one invoice: refused.
    const wrong = await finance
      .patch(
        `/customer-invoices/${extra.id}`,
        body([{ ...feeLine(fees[0]!.id, '30'), chargeTypeCode: 'DOCS' }]),
      )
      .expect(400);
    expect(wrong.body).toMatchObject({ code: 'CUSTOMS_FEE_LINE' });
    await finance
      .patch(
        `/customer-invoices/${extra.id}`,
        body([feeLine(fees[0]!.id, '30'), feeLine(fees[0]!.id, '30')]),
      )
      .expect(400);
    // Edited and kept: the links stay.
    await finance
      .patch(
        `/customer-invoices/${extra.id}`,
        body([feeLine(fees[0]!.id, '35'), feeLine(fees[1]!.id, '20')]),
      )
      .expect(200);

    // A fee on an invoice stays on its customs file.
    const kept = await admin
      .delete(`/shipments/${shipment.id}/customs/fees/${fees[0]!.id}`)
      .expect(409);
    expect(kept.body).toMatchObject({ code: 'CUSTOMS_FEE_INVOICED' });
    expect(
      (
        (await admin.get(`/shipments/${shipment.id}/customs`).expect(200))
          .body as ShipmentCustomsDto
      ).fees,
    ).toHaveLength(2);

    // Approved, the fees are invoiced: the shipment is no longer listed.
    expect(await listed()).toBe(true);
    await finance.post(`/customer-invoices/${extra.id}/approve`).expect(200);
    expect(await listed()).toBe(false);
  });
});
