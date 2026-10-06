import { randomInt, randomUUID } from 'node:crypto';
import type {
  ApiClientCreatedDto,
  ApiClientDto,
  BookingDto,
  CsCustomerDto,
  CsInvoiceDto,
  CsShipmentDto,
  CsShipmentSummaryDto,
  CustomerDto,
  CustomerInvoiceDto,
  ShipmentDto,
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

/** Every field the Customer Service API may return (scenario 23): Public or Customer-visible. */
const CUSTOMER_FIELDS = [
  'branchCode',
  'companyName',
  'contacts',
  'email',
  'isActive',
  'kind',
  'name',
  'number',
  'phone',
  'preferredCurrency',
  'preferredLocale',
  'whatsapp',
];
const CONTACT_FIELDS = [
  'canInquire',
  'canReceiveCargo',
  'canReceiveDocuments',
  'email',
  'isPrimary',
  'name',
  'phone',
  'position',
];
const SUMMARY_FIELDS = [
  'destination',
  'eta',
  'etd',
  'loadType',
  'mode',
  'number',
  'origin',
  'publicStatus',
  'status',
];
const SHIPMENT_FIELDS = [
  ...SUMMARY_FIELDS,
  'blNumber',
  'cargoType',
  'currentLocation',
  'customerNumber',
  'packages',
  'timeline',
  'vesselName',
  'volumeCbm',
  'voyageNumber',
  'weightKg',
];
const INVOICE_FIELDS = [
  'balance',
  'credited',
  'currency',
  'dueDate',
  'invoiceDate',
  'number',
  'paid',
  'shipmentNumber',
  'total',
];
const LOCATION_FIELDS = ['code', 'nameAr', 'nameEn'];
const TIMELINE_FIELDS = ['location', 'occurredAt', 'status'];

const keysOf = (value: object) => Object.keys(value).sort();

/**
 * Scenario 23: the Customer Service API, with its own key, returns a customer's shipment and
 * account data with no Internal or Restricted field (costs, margins, credit limits, internal
 * notes, reasons, ID numbers, who recorded what), and only for the key's branches.
 */
describe('Customer Service API', () => {
  let t: TestApp;
  let pts: string;
  let jed: string;
  let customer: CustomerDto;
  let shipment: ShipmentDto;
  let invoice: CustomerInvoiceDto;
  let ptsKey: ApiClientCreatedDto;
  let jedKey: ApiClientCreatedDto;
  const year = randomInt(1000, 1800);
  const secret = randomUUID().slice(0, 8);
  /** Internal and Restricted values the API must never return. */
  const SECRETS = {
    customerNote: `INTERNAL-NOTE-${secret}`,
    taxNumber: `TAX-${secret}`,
    idNumber: `IDN-${secret}`,
    creditLimit: '98765.4321',
    holdReason: `HOLD-REASON-${secret}`,
    eventNote: `EVENT-NOTE-${secret}`,
  };
  const contactPhone = uniquePhone();
  const cookies = { admin: '', management: '', salesPts: '', opsPts: '', financePts: '' };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const cs = (path: string, key: string) =>
    t.http().get(`/api/v1/cs${path}`).set('Authorization', `Bearer ${key}`);

  /** The response may hold none of the internal values, anywhere. */
  function expectNoSecrets(body: unknown) {
    const text = JSON.stringify(body);
    for (const value of [...Object.values(SECRETS), shipment.trackingToken, shipment.id]) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain('Integration Test');
  }

  beforeAll(async () => {
    t = await createTestApp();
    pts = await branchId(t.prisma, 'PTS');
    jed = await branchId(t.prisma, 'JED');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    // Approved invoices post entries that are never deleted: their users stay (LEDGER_PREFIX).
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      management: await createUser(t.prisma, ['MANAGEMENT'], [], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
      financePts: await createUser(t.prisma, ['FINANCE'], ['PTS'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }

    customer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Ledger CS ${year} ${secret}`,
        companyName: 'CS Test Trading LLC',
        phone: uniquePhone(),
        preferredCurrency: 'USD',
        taxNumber: SECRETS.taxNumber,
        notes: SECRETS.customerNote,
        creditLimit: SECRETS.creditLimit,
        creditLimitCurrency: 'USD',
        paymentTermsDays: 30,
      }).expect(201)
    ).body as CustomerDto;
    await post(`/customers/${customer.id}/contacts`, cookies.salesPts, {
      name: 'Amna Contact',
      position: 'Logistics',
      phone: contactPhone,
      idNumber: SECRETS.idNumber,
      canInquire: true,
      isPrimary: true,
    }).expect(201);

    const booking = (
      await post('/bookings', cookies.salesPts, {
        customerId: customer.id,
        originLocationId: await loc('SDPZU'),
        destinationLocationId: await loc('SDKRT'),
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [
          { cargoType: 'GENERAL', quantity: 3, weightKg: '300', volumeCbm: '1.5' },
          { cargoType: 'GENERAL', quantity: 2, weightKg: '200' },
        ],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesPts).expect(200))
      .body as BookingDto;
    const shipmentId = confirmed.shipmentId ?? '';
    await post(`/shipments/${shipmentId}/hold`, cookies.opsPts, {
      reason: SECRETS.holdReason,
    }).expect(200);
    await post(`/shipments/${shipmentId}/resume`, cookies.opsPts, {
      note: SECRETS.eventNote,
    }).expect(200);
    shipment = (await get(`/shipments/${shipmentId}`, cookies.opsPts).expect(200))
      .body as ShipmentDto;

    const draft = (await post('/customer-invoices', cookies.financePts, { shipmentId }).expect(201))
      .body as CustomerInvoiceDto;
    await patch(`/customer-invoices/${draft.id}`, cookies.financePts, {
      currency: 'USD',
      invoiceDate: `${year}-03-01`,
      dueDate: `${year}-03-31`,
      notes: SECRETS.customerNote,
      lines: [{ chargeTypeCode: 'FREIGHT', quantity: '1', unitPrice: '1250' }],
    }).expect(200);
    invoice = (await post(`/customer-invoices/${draft.id}/approve`, cookies.financePts).expect(200))
      .body as CustomerInvoiceDto;

    ptsKey = (
      await post('/api-clients', cookies.admin, {
        name: `CS test PTS ${secret}`,
        branchIds: [pts],
      }).expect(201)
    ).body as ApiClientCreatedDto;
    jedKey = (
      await post('/api-clients', cookies.admin, {
        name: `CS test JED ${secret}`,
        branchIds: [jed],
      }).expect(201)
    ).body as ApiClientCreatedDto;
  });

  afterAll(async () => {
    await t.close();
  });

  it('finds the customer by an authorized phone with customer-visible fields only', async () => {
    const found = (
      await cs(`/customers?phone=${encodeURIComponent(contactPhone)}`, ptsKey.key).expect(200)
    ).body as CsCustomerDto[];
    expect(found.map((c) => c.number)).toEqual([customer.number]);
    const [c] = found;
    if (!c) throw new Error('No customer');
    expect(keysOf(c)).toEqual(CUSTOMER_FIELDS);
    expect(c).toMatchObject({ branchCode: 'PTS', name: customer.name, phone: customer.phone });
    expect(c.contacts.map(keysOf)).toEqual([CONTACT_FIELDS]);
    expect(c.contacts[0]).toMatchObject({ name: 'Amna Contact', canInquire: true });
    expectNoSecrets(found);

    const one = (await cs(`/customers/${customer.number}`, ptsKey.key).expect(200))
      .body as CsCustomerDto;
    expect(one).toEqual(c);
    expect(JSON.stringify(one)).not.toContain('98765');
  });

  it('returns the shipment, its timeline and the account with no internal field', async () => {
    const list = (
      await cs(`/customers/${customer.number}/shipments?state=all`, ptsKey.key).expect(200)
    ).body as CsShipmentSummaryDto[];
    expect(list.map((s) => s.number)).toEqual([shipment.number]);
    expect(list.map(keysOf)).toEqual([SUMMARY_FIELDS]);
    const delivered = (
      await cs(`/customers/${customer.number}/shipments?state=delivered`, ptsKey.key).expect(200)
    ).body as CsShipmentSummaryDto[];
    expect(delivered).toEqual([]);

    const s = (await cs(`/shipments/${shipment.number}`, ptsKey.key).expect(200))
      .body as CsShipmentDto;
    expect(keysOf(s)).toEqual(SHIPMENT_FIELDS.sort());
    expect(keysOf(s.origin)).toEqual(LOCATION_FIELDS);
    expect(s).toMatchObject({
      customerNumber: customer.number,
      status: 'CREATED',
      publicStatus: 'REGISTERED',
      packages: 5,
      weightKg: '500',
      volumeCbm: '1.5',
      origin: { code: 'SDPZU' },
    });
    // The public path, as tracking shows it: the resumed hold is gone, with its reason and note.
    expect(s.timeline.map((e) => e.status)).toEqual(['REGISTERED']);
    for (const entry of s.timeline) expect(keysOf(entry)).toEqual(TIMELINE_FIELDS);
    expectNoSecrets(s);

    const invoices = (await cs(`/customers/${customer.number}/invoices`, ptsKey.key).expect(200))
      .body as CsInvoiceDto[];
    expect(invoices).toEqual([
      {
        number: invoice.number,
        shipmentNumber: shipment.number,
        invoiceDate: `${year}-03-01`,
        dueDate: `${year}-03-31`,
        currency: 'USD',
        total: '1250',
        paid: '0',
        credited: '0',
        balance: '1250',
      },
    ]);
    expect(invoices.map(keysOf)).toEqual([INVOICE_FIELDS]);
    expectNoSecrets(invoices);
  });

  it('reads only the branches of its key, and only with a valid key', async () => {
    await cs(`/customers/${customer.number}`, jedKey.key).expect(404);
    await cs(`/shipments/${shipment.number}`, jedKey.key).expect(404);
    await cs(`/customers/${customer.number}/invoices`, jedKey.key).expect(404);
    expect(
      (await cs(`/customers?phone=${encodeURIComponent(contactPhone)}`, jedKey.key).expect(200))
        .body,
    ).toEqual([]);

    const path = `/customers/${customer.number}`;
    await t.http().get(`/api/v1/cs${path}`).expect(401);
    // A staff session is not a key, and a key is not a staff session.
    await get(`/cs${path}`, cookies.admin).expect(401);
    await t
      .http()
      .get('/api/v1/customers')
      .set('Authorization', `Bearer ${ptsKey.key}`)
      .expect(401);
    await cs(path, `${ptsKey.key.slice(0, -1)}A`).expect(401);
    await cs(path, ptsKey.key.replace(/_[^_]+$/, `_${'x'.repeat(43)}`)).expect(401);
    await cs(path, 'not-a-key').expect(401);
    // Bad queries are refused, not widened.
    await cs('/customers?phone=0912345678', ptsKey.key).expect(400);
    await cs('/customers', ptsKey.key).expect(400);
    await cs(`${path}/shipments?state=cancelled`, ptsKey.key).expect(400);
    await cs(`${path}/shipments?limit=500`, ptsKey.key).expect(400);
  });

  it('does not open a shipment to the key of a branch it is only shared with', async () => {
    const shared = (
      await patch(`/shipments/${shipment.id}`, cookies.opsPts, { sharedBranchIds: [jed] }).expect(
        200,
      )
    ).body as ShipmentDto;
    expect(shared.sharedBranchIds).toEqual([jed]);
    try {
      // Owned by PTS, shared with JED: the JED key still does not find it.
      await cs(`/shipments/${shipment.number}`, jedKey.key).expect(404);
      await cs(`/customers/${customer.number}/shipments?state=all`, jedKey.key).expect(404);
      // The owner's key is unchanged.
      await cs(`/shipments/${shipment.number}`, ptsKey.key).expect(200);
    } finally {
      await patch(`/shipments/${shipment.id}`, cookies.opsPts, { sharedBranchIds: [] }).expect(200);
    }
  });

  it('lets only the Administrator make and revoke keys, shown once', async () => {
    await post('/api-clients', cookies.management, { name: 'x', branchIds: [pts] }).expect(403);
    await post('/api-clients', cookies.financePts, { name: 'x', branchIds: [pts] }).expect(403);
    await get('/api-clients', cookies.management).expect(403);
    await post('/api-clients', cookies.admin, { name: 'x', branchIds: [] }).expect(400);
    await post('/api-clients', cookies.admin, { name: 'x', branchIds: [randomUUID()] }).expect(403);

    const listed = (await get('/api-clients', cookies.admin).expect(200)).body as ApiClientDto[];
    const mine = listed.find((c) => c.id === ptsKey.client.id);
    expect(mine).toMatchObject({ branchCodes: ['PTS'], isActive: true });
    expect(mine?.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(ptsKey.key);
    const row = await t.prisma.apiClient.findUniqueOrThrow({ where: { id: ptsKey.client.id } });
    expect(row.keyHash).not.toContain(ptsKey.key);

    const revoked = (
      await post(`/api-clients/${jedKey.client.id}/revoke`, cookies.admin).expect(200)
    ).body as ApiClientDto;
    expect(revoked).toMatchObject({ isActive: false });
    await post(`/api-clients/${jedKey.client.id}/revoke`, cookies.admin).expect(409);
    await cs(`/customers?phone=${encodeURIComponent(contactPhone)}`, jedKey.key).expect(401);
    await post(`/api-clients/${ptsKey.client.id}/revoke`, cookies.financePts).expect(403);
    await cs(`/customers/${customer.number}`, ptsKey.key).expect(200);
  });
});
