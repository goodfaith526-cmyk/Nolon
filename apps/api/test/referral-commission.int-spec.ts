import { randomUUID } from 'node:crypto';
import type {
  AccountDto,
  BookingDto,
  CustomerDto,
  CustomerInvoiceDto,
  PartnerDto,
  ShipmentDto,
  WindowDeskReferrerDto,
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
import { uniquePhone, waitForLockWaiter } from './test-data.js';

/**
 * Plan 18, 4 (build 18-2): the referral broker's commission. The customer's broker earns on the
 * customer's first paid shipment (taken when the shipment's first invoice is approved, whatever the
 * order of receipt and payment); after that, a broker earns only on a shipment he brings to the
 * window in person. Posted entries are never deleted: every user is a LEDGER user, every customer
 * and partner this run's own.
 */
describe('Referral broker commission (plan 18-2)', () => {
  let t: TestApp;
  let pts = '';
  let jed = '';
  const tag = `RC${randomUUID().slice(0, 5).toUpperCase()}`;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const today = new Date().toISOString().slice(0, 10);

  const as = (cookie: string) => ({
    get: (path: string) => t.http().get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object = {}) =>
      t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    patch: (path: string, body: object) =>
      t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
    put: (path: string, body: object) =>
      t.http().put(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body),
  });
  const refusal = (body: unknown) => body as { code?: string; fields?: string[] };

  /** A referrer of `branch` earning 25 USD a shipment when invoiced. */
  async function broker(name: string, branch = pts): Promise<PartnerDto> {
    const made = (
      await as(cookies.admin!)
        .post('/partners', {
          kind: 'REFERRER',
          branchId: branch,
          name: `${tag} broker ${name}`,
          phone: uniquePhone(),
          countryCode: 'SD',
          currency: 'USD',
        })
        .expect(201)
    ).body as PartnerDto;
    const contract = (
      await as(cookies.admin!)
        .post(`/partners/${made.id}/contracts`, {
          validFrom: '2020-01-01',
          basis: 'FIXED_PER_UNIT',
          value: '25',
          unit: 'PER_SHIPMENT',
          currency: 'USD',
        })
        .expect(201)
    ).body as { id: string };
    await as(cookies.admin!).post(`/partner-contracts/${contract.id}/approve`).expect(200);
    return made;
  }

  /** A new customer, linked to `referrer` by staff when given. */
  async function customer(referrer?: PartnerDto): Promise<string> {
    const made = (
      await as(cookies.sales!)
        .post('/customers', {
          kind: 'COMPANY',
          name: `${tag} customer ${randomUUID().slice(0, 4)}`,
          phone: uniquePhone(),
          preferredCurrency: 'USD',
        })
        .expect(201)
    ).body as CustomerDto;
    if (referrer) {
      await as(cookies.admin!)
        .post(`/customers/${made.id}/referrer`, { partnerId: referrer.id, reason: 'Registered' })
        .expect(200);
    }
    return made.id;
  }

  /** A confirmed booking of `customerId` at window A with a pro forma MAIN invoice of 100 USD. */
  async function proForma(
    customerId: string,
  ): Promise<{ booking: string; shipment: string; invoice: string }> {
    const sales = as(cookies.sales!);
    const booking = (
      await sales
        .post('/bookings', {
          customerId,
          branchId: pts,
          originLocationId: ids.origin,
          destinationLocationId: ids.dest,
          mode: 'ROAD',
          services: ['MAIN_FREIGHT'],
          dropOffWarehouseId: ids.window,
          items: [{ cargoType: 'GENERAL', quantity: 1, volumeCbm: '1', weightKg: '100' }],
        })
        .expect(201)
    ).body as BookingDto;
    const confirmed = (await sales.post(`/bookings/${booking.id}/confirm`).expect(200))
      .body as BookingDto;
    const finance = as(cookies.finance!);
    const draft = (
      await finance.post('/customer-invoices', { shipmentId: confirmed.shipmentId }).expect(201)
    ).body as CustomerInvoiceDto;
    await finance
      .patch(`/customer-invoices/${draft.id}`, {
        currency: 'USD',
        invoiceDate: today,
        dueDate: today,
        repriced: true,
        lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '100' }],
      })
      .expect(200);
    return { booking: booking.id, shipment: confirmed.shipmentId!, invoice: draft.id };
  }

  const receive = (bookingId: string, broughtByReferrerId?: string) =>
    as(cookies.staff!).post(`/window-desk/bookings/${bookingId}/receipt`, {
      packages: 1,
      condition: 'GOOD',
      partyName: `${tag} courier`,
      ...(broughtByReferrerId ? { broughtByReferrerId } : {}),
    });
  const pay = (bookingId: string) =>
    as(cookies.staff!).post(`/window-desk/bookings/${bookingId}/payment`, {
      requestId: randomUUID(),
      amount: '100',
      currency: 'USD',
    });
  const referralOf = (shipmentId: string) =>
    t.prisma.shipmentReferral.findUnique({ where: { shipmentId } });
  /** The REFERRER commission on the shipment, per partner (net). */
  async function earned(shipmentId: string): Promise<Record<string, string>> {
    const rows = await t.prisma.commissionAccrual.findMany({
      where: { shipmentId, role: 'REFERRER' },
    });
    const sums: Record<string, string> = {};
    for (const r of rows) {
      const before = sums[r.partnerId];
      sums[r.partnerId] = (before ? r.amount.plus(before) : r.amount).toFixed();
    }
    return Object.fromEntries(Object.entries(sums).filter(([, v]) => v !== '0'));
  }

  beforeAll(async () => {
    t = await createTestApp({ WINDOW_DESK_ENABLED: true, WINDOW_COLLECT_ENABLED: true });
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    ids.origin = await loc('SDPZU');
    ids.dest = await loc('SDKRT');
    const admin = await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX);
    ids.admin = admin.id;
    cookies.admin = await signIn(t, admin.email);
    cookies.sales = await signIn(
      t,
      (await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX)).email,
    );
    cookies.finance = await signIn(
      t,
      (await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX)).email,
    );
    cookies.ops = await signIn(
      t,
      (await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX)).email,
    );
    cookies.warehouse = await signIn(
      t,
      (await createUser(t.prisma, ['WAREHOUSE'], ['PTS'], LEDGER_PREFIX)).email,
    );
    const outlet = await t.prisma.partner.create({
      data: {
        number: `${tag}-W`,
        kind: 'SALES_OUTLET',
        branchId: pts,
        name: `${tag} window outlet`,
        countryCode: 'SD',
        currency: 'USD',
        createdById: admin.id,
      },
    });
    ids.window = (
      await t.prisma.warehouse.create({
        data: {
          branchId: pts,
          code: `${tag}-W`,
          nameAr: 'نافذة المندوب',
          nameEn: 'Broker window',
          acceptsDropOff: true,
          partnerId: outlet.id,
        },
      })
    ).id;
    const staff = await createUser(t.prisma, ['OUTLET_STAFF'], ['PTS'], LEDGER_PREFIX);
    await t.prisma.userPartner.create({ data: { userId: staff.id, partnerId: outlet.id } });
    cookies.staff = await signIn(t, staff.email);
    const cash = (
      await as(cookies.admin)
        .post('/accounting/accounts', {
          code: `${tag}U`,
          nameEn: `Cash at window ${tag}`,
          nameAr: 'نقدية لدى نافذة',
          type: 'ASSET',
          isPostable: true,
          isCash: true,
          currency: 'USD',
          branchId: pts,
        })
        .expect(201)
    ).body as AccountDto;
    await as(cookies.admin)
      .put(`/warehouses/${ids.window}/cash-accounts/USD`, { accountId: cash.id })
      .expect(200);
  });

  afterAll(async () => {
    await t?.close();
  });

  describe("the customer's first paid shipment", () => {
    it('pays the customer’s broker on the first, and nothing on the next', async () => {
      const a = await broker('A');
      const c = await customer(a);
      const first = await proForma(c);
      await pay(first.booking).expect(201);
      expect(await referralOf(first.shipment)).toMatchObject({
        firstForCustomerId: c,
        referrerId: a.id,
        referrerReason: 'FIRST_SHIPMENT',
        broughtByPartnerId: null,
      });
      expect(await earned(first.shipment)).toEqual({ [a.id]: '25' });
      const shown = (await as(cookies.ops!).get(`/shipments/${first.shipment}`).expect(200))
        .body as ShipmentDto;
      expect(shown.referral).toMatchObject({
        referrer: { id: a.id },
        reason: 'FIRST_SHIPMENT',
        broughtBy: null,
      });
      const next = await proForma(c);
      await pay(next.booking).expect(201);
      expect(await referralOf(next.shipment)).toBeNull();
      expect(await earned(next.shipment)).toEqual({});
    });

    it('gives the same answer in either order with the same broker, a different one, or none', async () => {
      const a = await broker('A2');
      const b = await broker('B2');
      for (const order of ['receiptFirst', 'paymentFirst'] as const) {
        for (const carrier of [a, b, null]) {
          const c = await customer(a);
          const s = await proForma(c);
          if (order === 'receiptFirst') {
            await receive(s.booking, carrier?.id).expect(201);
            await pay(s.booking).expect(201);
          } else {
            await pay(s.booking).expect(201);
            await receive(s.booking, carrier?.id).expect(201);
          }
          const label = `${order} ${carrier === a ? 'same' : carrier ? 'other' : 'none'}`;
          expect(await referralOf(s.shipment), label).toMatchObject({
            firstForCustomerId: c,
            referrerId: a.id,
            referrerReason: 'FIRST_SHIPMENT',
            broughtByPartnerId: carrier?.id ?? null,
          });
          // One commission: the customer's broker, never the carrier on the first.
          expect(await earned(s.shipment), label).toEqual({ [a.id]: '25' });
        }
      }
    });

    it('pays a broker who brings a later shipment, or a customer of no broker, in person', async () => {
      const a = await broker('A3');
      const b = await broker('B3');
      const c = await customer(a);
      await pay((await proForma(c)).booking).expect(201);
      for (const order of ['receiptFirst', 'paymentFirst'] as const) {
        const s = await proForma(c);
        if (order === 'receiptFirst') {
          await receive(s.booking, b.id).expect(201);
          await pay(s.booking).expect(201);
        } else {
          await pay(s.booking).expect(201);
          await receive(s.booking, b.id).expect(201);
        }
        expect(await referralOf(s.shipment), order).toMatchObject({
          firstForCustomerId: null,
          referrerId: b.id,
          referrerReason: 'BROUGHT_IN_PERSON',
        });
        expect(await earned(s.shipment), order).toEqual({ [b.id]: '25' });
      }
      // A customer with no broker at all.
      const alone = await proForma(await customer());
      await receive(alone.booking, b.id).expect(201);
      await pay(alone.booking).expect(201);
      expect(await earned(alone.shipment)).toEqual({ [b.id]: '25' });
    });

    it('takes no first past the broker’s expiry, nor for an inactive broker', async () => {
      const late = await broker('Late');
      await as(cookies.admin!).patch(`/partners/${late.id}`, { referralWindowDays: 3 }).expect(200);
      const c = await customer(late);
      await t.prisma.customer.update({
        where: { id: c },
        data: { referredAt: new Date(Date.now() - 10 * 86_400_000) },
      });
      const s = await proForma(c);
      await pay(s.booking).expect(201);
      expect(await referralOf(s.shipment)).toBeNull();
      // Within the window it is taken.
      await as(cookies.admin!)
        .patch(`/partners/${late.id}`, { referralWindowDays: 30 })
        .expect(200);
      const within = await proForma(c);
      await pay(within.booking).expect(201);
      expect((await referralOf(within.shipment))?.referrerReason).toBe('FIRST_SHIPMENT');

      const gone = await broker('Gone');
      const c2 = await customer(gone);
      await as(cookies.admin!).patch(`/partners/${gone.id}`, { isActive: false }).expect(200);
      const s2 = await proForma(c2);
      await pay(s2.booking).expect(201);
      expect(await referralOf(s2.shipment)).toBeNull();
    });

    it('keeps the first on its shipment when staff change the customer’s broker later', async () => {
      const a = await broker('A4');
      const b = await broker('B4');
      const c = await customer(a);
      const s = await proForma(c);
      await pay(s.booking).expect(201);
      await as(cookies.admin!)
        .post(`/customers/${c}/referrer`, { partnerId: b.id, reason: 'Moved' })
        .expect(200);
      // A later write on the shipment decides again: the first stays the first broker's.
      await as(cookies.ops!)
        .post(`/shipments/${s.shipment}/referrer`, { partnerId: b.id, reason: 'He carried it' })
        .expect(200);
      expect(await referralOf(s.shipment)).toMatchObject({
        referrerId: a.id,
        referrerReason: 'FIRST_SHIPMENT',
        broughtByPartnerId: b.id,
      });
      expect(await earned(s.shipment)).toEqual({ [a.id]: '25' });
      const next = await proForma(c);
      await pay(next.booking).expect(201);
      expect(await referralOf(next.shipment)).toBeNull();
    });

    it('frees the first when its shipment is cancelled; the next approved one takes it', async () => {
      const a = await broker('A5');
      const c = await customer(a);
      const s = await proForma(c);
      const finance = as(cookies.finance!);
      await finance.post(`/customer-invoices/${s.invoice}/approve`).expect(200);
      expect((await referralOf(s.shipment))?.firstForCustomerId).toBe(c);
      expect(await earned(s.shipment)).toEqual({ [a.id]: '25' });
      // A full credit keeps the first (a return is no new chance), then the cancel frees it.
      const note = (
        await finance
          .post('/credit-notes', {
            requestId: randomUUID(),
            invoiceId: s.invoice,
            creditDate: today,
            amount: '100',
            reason: 'Returned',
          })
          .expect(201)
      ).body as { id: string };
      await as(cookies.admin!).post(`/credit-notes/${note.id}/approve`).expect(200);
      expect((await referralOf(s.shipment))?.firstForCustomerId).toBe(c);
      await as(cookies.ops!)
        .post(`/shipments/${s.shipment}/cancel`, { reason: 'Customer withdrew' })
        .expect(200);
      expect(await referralOf(s.shipment)).toMatchObject({
        firstForCustomerId: null,
        referrerId: null,
        referrerReason: null,
      });
      expect(await earned(s.shipment)).toEqual({});
      const next = await proForma(c);
      await pay(next.booking).expect(201);
      expect(await referralOf(next.shipment)).toMatchObject({
        firstForCustomerId: c,
        referrerId: a.id,
        referrerReason: 'FIRST_SHIPMENT',
      });
    });

    it('lets exactly one of two first invoices approved at once take the first', async () => {
      const a = await broker('A6');
      const c = await customer(a);
      const [x, y] = [await proForma(c), await proForma(c)];
      const finance = as(cookies.finance!);
      // Hold the customer's first-lock until both approvals wait on it, so they truly race.
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held = () => {};
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = t.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`referral-first:${c}`}, 0))`;
          held();
          await gate;
        },
        { timeout: 30_000 },
      );
      await holding;
      const racing = Promise.all([
        finance.post(`/customer-invoices/${x.invoice}/approve`),
        finance.post(`/customer-invoices/${y.invoice}/approve`),
      ]);
      await waitForLockWaiter(t.prisma, 2);
      release();
      await holder;
      const results = await racing;
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const firsts = await t.prisma.shipmentReferral.count({ where: { firstForCustomerId: c } });
      expect(firsts).toBe(1);
      const paid = { ...(await earned(x.shipment)), ...(await earned(y.shipment)) };
      expect(paid).toEqual({ [a.id]: '25' });
    });
  });

  describe('the broker picked at the window, and corrected by staff', () => {
    it('lists the active brokers of the booking’s branch, by name, with no phone', async () => {
      const a = await broker('Listed');
      const off = await broker('Off');
      await as(cookies.admin!).patch(`/partners/${off.id}`, { isActive: false }).expect(200);
      const elsewhere = await broker('Elsewhere', jed);
      const s = await proForma(await customer());
      const list = (
        await as(cookies.staff!)
          .get(`/window-desk/bookings/${s.booking}/referrers?q=${encodeURIComponent(tag)}`)
          .expect(200)
      ).body as WindowDeskReferrerDto[];
      const shown = list.map((r) => r.id);
      expect(shown).toContain(a.id);
      expect(shown).not.toContain(off.id);
      expect(shown).not.toContain(elsewhere.id);
      expect(Object.keys(list[0]!).sort()).toEqual(['id', 'name', 'number']);
      // Staff routes stay closed to the window; the window's route to staff.
      await as(cookies.ops!).get(`/window-desk/bookings/${s.booking}/referrers`).expect(403);
      // Another branch's, an inactive or another kind of partner is refused at receipt.
      for (const id of [elsewhere.id, off.id, randomUUID()]) {
        const res = await receive(s.booking, id).expect(400);
        expect(refusal(res.body)).toMatchObject({
          code: 'PARTNER_NOT_USABLE',
          fields: ['broughtByReferrerId'],
        });
      }
      expect(await referralOf(s.shipment)).toBeNull();
    });

    it('lets staff correct the broker with a reason, moving the commission', async () => {
      const a = await broker('A7');
      const b = await broker('B7');
      const s = await proForma(await customer());
      await receive(s.booking, a.id).expect(201);
      await pay(s.booking).expect(201);
      expect(await earned(s.shipment)).toEqual({ [a.id]: '25' });
      const ops = as(cookies.ops!);
      const moved = (
        await ops
          .post(`/shipments/${s.shipment}/referrer`, { partnerId: b.id, reason: 'Wrong pick' })
          .expect(200)
      ).body as ShipmentDto;
      expect(moved.referral).toMatchObject({
        broughtBy: { id: b.id },
        referrer: { id: b.id },
        reason: 'BROUGHT_IN_PERSON',
      });
      expect(await earned(s.shipment)).toEqual({ [b.id]: '25' });
      const audit = await t.prisma.auditEvent.findMany({ where: { entityId: s.shipment } });
      expect(JSON.stringify(audit.map((e) => e.changes))).toContain('Wrong pick');
      await ops
        .post(`/shipments/${s.shipment}/referrer`, { partnerId: null, reason: 'No broker' })
        .expect(200);
      expect(await earned(s.shipment)).toEqual({});
      // Refused: no reason, another kind of partner, no permission.
      await ops.post(`/shipments/${s.shipment}/referrer`, { partnerId: a.id }).expect(400);
      const res = await ops
        .post(`/shipments/${s.shipment}/referrer`, { partnerId: ids.window, reason: 'x' })
        .expect(400);
      expect(refusal(res.body).code).toBe('PARTNER_NOT_USABLE');
      await as(cookies.warehouse!)
        .post(`/shipments/${s.shipment}/referrer`, { partnerId: a.id, reason: 'x' })
        .expect(403);
    });
  });
});
