import { randomInt, randomUUID } from 'node:crypto';
import type {
  AgentClientCreatedDto,
  AssistantDraftDto,
  BookingDraftDto,
  BookingDto,
  ConsolidationDto,
  CustomerDto,
  DraftPreCheckDto,
  DriverDto,
  EntryDraftSummaryDto,
  QuotationDraftDto,
  RateCardDraftDto,
  ShipmentDto,
  TripDraftDto,
  VehicleDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  deleteTestUsers,
  signIn,
} from './auth-test-app.js';
import {
  AGENT_PREFIX,
  draftKey,
  registerClient,
  requests,
  tokenFor,
} from './agent-drafts-helpers.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

// Entry drafts saved with missing values (owner decision, 2026-10-17): a trip, rate card,
// quotation or booking draft is saved with only its key fields; a person fills in the rest on the
// review screen (PATCH), and an approval is refused (422 DRAFT_INCOMPLETE) while anything the
// record needs is missing. The assistant's agent-it- users create drafts; it- users decide.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let jebelAli: string;
let portSudan: string;
let khartoum: string;
let customer: CustomerDto;
let jedCustomer: CustomerDto;
let vehicle: VehicleDto;
let driver: DriverDto;

const cookies = {
  admin: '',
  salesDxb: '',
  salesJed: '',
  opsDxb: '',
  opsJed: '',
  whDxb: '',
};
const agentCookies = { salesAgent: '', opsAgent: '' };
const tokens = { sales: '', ops: '' };
const ids = { salesAgent: '', opsAgent: '' };

// Each rate starts on a day of its own, in a range no other spec uses (one offer per start date).
let rateDay = randomInt(20_000, 35_000);
const nextRateDay = () =>
  new Date(Date.UTC(1900, 0, 1) + rateDay++ * 86_400_000).toISOString().slice(0, 10);
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const summary = (res: { body: unknown }) => res.body as EntryDraftSummaryDto;
const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

/** Containers this spec made, removed after it. */
const containerIds: string[] = [];

/** A container of a branch, from Jebel Ali to Port Sudan; cancelled when asked. */
async function containerOf(
  branch: string,
  cookie: string,
  cancelled = false,
): Promise<ConsolidationDto> {
  const made = (
    await r
      .post('/consolidations', cookie, {
        branchId: branch,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        containerTypeCode: '20GP',
        vesselName: 'ZZ MF Vessel',
        etd: inDays(30),
        shipmentIds: [],
      })
      .expect(201)
  ).body as ConsolidationDto;
  containerIds.push(made.id);
  if (cancelled) {
    await r.post(`/consolidations/${made.id}/cancel`, cookie, { reason: 'Test' }).expect(200);
  }
  return made;
}

/** A confirmed road booking of the DXB customer; its shipment. */
async function roadShipment(): Promise<ShipmentDto> {
  const booking = (
    await r
      .post('/bookings', cookies.opsDxb, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 4, weightKg: '400' }],
      })
      .expect(201)
  ).body as BookingDto;
  const confirmed = (await r.post(`/bookings/${booking.id}/confirm`, cookies.opsDxb).expect(200))
    .body as BookingDto;
  return (await r.get(`/shipments/${confirmed.shipmentId}`, cookies.opsDxb).expect(200))
    .body as ShipmentDto;
}

/** The incomplete draft's 422: nothing recorded, each missing value named. */
function expectIncomplete(res: { status: number; body: unknown }, missing: string[]) {
  expect(res.status).toBe(422);
  expect(res.body).toMatchObject({
    statusCode: 422,
    code: 'DRAFT_INCOMPLETE',
    missingFields: missing,
    fields: missing,
  });
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
  const jed = await branchId(t.prisma, 'JED');
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  jebelAli = await loc('AEJEA');
  portSudan = await loc('SDPZU');
  khartoum = await loc('SDKRT');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
    salesJed: await createUser(t.prisma, ['SALES'], ['JED']),
    opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
    opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED']),
    whDxb: await createUser(t.prisma, ['WAREHOUSE'], ['DXB']),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const assistantUsers = {
    salesAgent: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    opsAgent: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
    ids[key] = assistantUsers[key].id;
  }
  client = await registerClient(t, cookies.admin, 'Missing fields draft platform');
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);

  const newCustomer = async (branch: string, cookie: string, name: string) =>
    (
      await r
        .post('/customers', cookie, {
          branchId: branch,
          kind: 'COMPANY',
          name,
          phone: uniquePhone(),
        })
        .expect(201)
    ).body as CustomerDto;
  customer = await newCustomer(dxb, cookies.salesDxb, 'Missing Fields Test Trading');
  jedCustomer = await newCustomer(jed, cookies.salesJed, 'Missing Fields JED Trading');
  const suffix = String(randomInt(100_000, 999_999));
  vehicle = (
    await r
      .post('/transport/vehicles', cookies.opsDxb, {
        branchId: dxb,
        plateNumber: `ZZ MF ${suffix}`,
        vehicleType: 'Flatbed trailer',
      })
      .expect(201)
  ).body as VehicleDto;
  driver = (
    await r
      .post('/transport/drivers', cookies.opsDxb, { branchId: dxb, name: `ZZ MF Driver ${suffix}` })
      .expect(201)
  ).body as DriverDto;
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await t.prisma.bookingDraft.deleteMany({ where: { consolidationId: { in: containerIds } } });
  await t.prisma.consolidation.deleteMany({ where: { id: { in: containerIds } } });
  await deleteTestUsers(t.prisma);
  await t.close();
});

// -------------------------------------------------------------------------------------------
// Trips
// -------------------------------------------------------------------------------------------

const TRIP_MISSING = [
  'originLocationId',
  'destinationLocationId',
  'vehicleId',
  'driverId',
  'shipmentIds',
];

describe('trip drafts with missing values', () => {
  const create = (body: object, token = tokens.ops) => r.agentPost('/trip-drafts', token, body);
  const read = async (id: string) =>
    (await r.get(`/trip-drafts/${id}`, cookies.opsDxb).expect(200)).body as TripDraftDto;

  it('saves a draft with only its branch and kind, and names what it misses', async () => {
    const body = { idempotencyKey: draftKey(), branchId: dxb, kind: 'OWN' };
    const created = summary(await create(body).expect(201));
    expect(created).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 0 });
    expect(created.missingFields).toEqual(TRIP_MISSING);
    const draft = await read(created.id);
    expect(draft).toMatchObject({
      missingFields: TRIP_MISSING,
      check: null,
      actions: { canEdit: true, canDecide: true },
      subject: '? → ?',
    });
    expect(draft.request).toMatchObject({
      originLocationId: null,
      destinationLocationId: null,
      shipmentIds: [],
    });
    // The same request under the same key is the same draft; the key finds it.
    expect(summary(await create(body).expect(201)).id).toBe(created.id);
    const found = await r.agentGet(`/trip-drafts/by-key/${body.idempotencyKey}`, tokens.ops);
    expect(summary(found).id).toBe(created.id);
  });

  it('still checks every value given, and the key fields', async () => {
    const base = { branchId: dxb, kind: 'OWN' };
    const before = await t.prisma.tripDraft.count();
    await create({ idempotencyKey: draftKey(), kind: 'OWN' }).expect(400);
    await create({ idempotencyKey: draftKey(), branchId: dxb }).expect(400);
    await create({ ...base, idempotencyKey: draftKey(), originLocationId: 'nope' }).expect(400);
    // An unknown location, a route to itself, a carrier on an own trip, another branch.
    await create({ ...base, idempotencyKey: draftKey(), originLocationId: randomUUID() }).expect(
      400,
    );
    await create({
      ...base,
      idempotencyKey: draftKey(),
      originLocationId: portSudan,
      destinationLocationId: portSudan,
    }).expect(400);
    await create({ ...base, idempotencyKey: draftKey(), agreedCost: '10' }).expect(400);
    await create({ ...base, idempotencyKey: draftKey(), shipmentIds: [customer.id] }).expect(404);
    const jed = await branchId(t.prisma, 'JED');
    await create({ ...base, idempotencyKey: draftKey(), branchId: jed }).expect(403);
    expect(await t.prisma.tripDraft.count()).toBe(before);
  });

  it('pre-checks the values and names what a draft would miss', async () => {
    const res = await r
      .agentPost('/trip-drafts/check', tokens.ops, {
        branchId: dxb,
        kind: 'OWN',
        originLocationId: portSudan,
      })
      .expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      missingFields: ['destinationLocationId', 'vehicleId', 'driverId', 'shipmentIds'],
    });
    const refused = (
      await r
        .agentPost('/trip-drafts/check', tokens.ops, {
          branchId: dxb,
          kind: 'OWN',
          originLocationId: randomUUID(),
        })
        .expect(200)
    ).body as DraftPreCheckDto;
    expect(refused.ok).toBe(false);
  });

  it('refuses the approval while values are missing, then approves once filled in', async () => {
    const body = {
      idempotencyKey: draftKey(),
      branchId: dxb,
      kind: 'OWN',
      originLocationId: portSudan,
    };
    const { id } = summary(await create(body).expect(201));
    const missing = TRIP_MISSING.slice(1);
    expectIncomplete(await r.post(`/trip-drafts/${id}/approve`, cookies.opsDxb, { version: 1 }), [
      ...missing,
    ]);
    expect((await read(id)).status).toBe('DRAFT');

    const shipment = await roadShipment();
    const filled = (
      await r
        .patch(`/trip-drafts/${id}`, cookies.opsDxb, {
          version: 1,
          destinationLocationId: khartoum,
          vehicleId: vehicle.id,
          driverId: driver.id,
          shipmentIds: [shipment.id],
        })
        .expect(200)
    ).body as TripDraftDto;
    expect(filled).toMatchObject({
      version: 2,
      missingFields: [],
      check: { ok: true },
      shipmentNumbers: [shipment.number],
    });
    await r.post(`/trip-drafts/${id}/approve`, cookies.opsDxb, { version: 1 }).expect(409);
    const approved = (
      await r.post(`/trip-drafts/${id}/approve`, cookies.opsDxb, { version: 2 }).expect(200)
    ).body as TripDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', version: 3 });
    expect(approved.tripId).not.toBeNull();
    // The assistant's replay of its create, and its key, still find this draft.
    expect(summary(await create(body).expect(201))).toMatchObject({ id, status: 'APPROVED' });
    const found = await r.agentGet(`/trip-drafts/by-key/${body.idempotencyKey}`, tokens.ops);
    expect(summary(found).id).toBe(id);
    // A decided draft takes no edit.
    await r.patch(`/trip-drafts/${id}`, cookies.opsDxb, { version: 3, notes: 'x' }).expect(409);
  });

  it('refuses an approval from the assistant chat while values are missing', async () => {
    await r
      .put(`/users/${ids.opsAgent}/assistant-approvals`, cookies.admin, { kinds: ['trip'] })
      .expect(200);
    const { id } = summary(
      await create({ idempotencyKey: draftKey(), branchId: dxb, kind: 'OWN' }).expect(201),
    );
    const card = (await r.agentGet(`/trip-drafts/${id}/assistant`, tokens.ops).expect(200))
      .body as AssistantDraftDto<TripDraftDto>;
    expect(card.draft.missingFields).toEqual(TRIP_MISSING);
    expectIncomplete(
      await r.agentPost(`/trip-drafts/${id}/assistant-approve`, tokens.ops, {
        version: 1,
        contentHash: card.contentHash,
      }),
      TRIP_MISSING,
    );
    expect(await read(id)).toMatchObject({ status: 'DRAFT', tripId: null });
  });

  it('edits only an open draft of the branches held, with the permission, at its version', async () => {
    const { id } = summary(
      await create({ idempotencyKey: draftKey(), branchId: dxb, kind: 'OWN' }).expect(201),
    );
    const edit = (cookie: string, body: object) => r.patch(`/trip-drafts/${id}`, cookie, body);
    await edit(cookies.opsJed, { version: 1, notes: 'x' }).expect(404);
    await edit(cookies.salesDxb, { version: 1, notes: 'x' }).expect(403);
    await r.agentPatch(`/trip-drafts/${id}`, tokens.ops, { version: 1, notes: 'x' }).expect(403);
    await edit(cookies.opsDxb, { version: 2, notes: 'x' }).expect(409);
    await edit(cookies.opsDxb, { version: 1, originLocationId: 'nope' }).expect(400);
    await edit(cookies.opsDxb, { version: 1, originLocationId: randomUUID() }).expect(400);
    await edit(cookies.opsDxb, { version: 1, branchId: dxb }).expect(400);
    await edit(cookies.opsDxb, { version: 1, carrierId: randomUUID() }).expect(400);
    expect((await read(id)).version).toBe(1);
    const changed = (await edit(cookies.opsDxb, { version: 1, notes: 'Night run' }).expect(200))
      .body as TripDraftDto;
    expect(changed).toMatchObject({ version: 2, request: { notes: 'Night run' } });
    await r
      .post(`/trip-drafts/${id}/reject`, cookies.opsDxb, { version: 2, reason: 'Not needed' })
      .expect(200);
    await edit(cookies.opsDxb, { version: 3, notes: 'y' }).expect(409);
  });
});

// -------------------------------------------------------------------------------------------
// Rate cards
// -------------------------------------------------------------------------------------------

const RATE_MISSING = [
  'originLocationId',
  'destinationLocationId',
  'mode',
  'cargoType',
  'unit',
  'price',
  'currency',
  'validFrom',
];

describe('rate card drafts with missing values', () => {
  const create = (body: object) => r.agentPost('/rate-card-drafts', tokens.sales, body);
  const read = async (id: string) =>
    (await r.get(`/rate-card-drafts/${id}`, cookies.salesDxb).expect(200)).body as RateCardDraftDto;

  it('saves a draft with only its branch, and names what it misses', async () => {
    const body = { idempotencyKey: draftKey(), branchId: dxb };
    const created = summary(await create(body).expect(201));
    expect(created.missingFields).toEqual(RATE_MISSING);
    const draft = await read(created.id);
    expect(draft).toMatchObject({
      missingFields: RATE_MISSING,
      check: null,
      originCode: null,
      destinationCode: null,
      actions: { canEdit: true, canDecide: true },
    });
    expect(draft.request).toMatchObject({ price: null, currency: null, validFrom: null });
    expect(summary(await create(body).expect(201)).id).toBe(created.id);
    // A container rate also needs its container type.
    const container = summary(
      await create({ idempotencyKey: draftKey(), branchId: dxb, cargoType: 'CONTAINER' }).expect(
        201,
      ),
    );
    expect(container.missingFields).toEqual([
      ...RATE_MISSING.filter((f) => f !== 'cargoType'),
      'containerTypeCode',
    ]);
  });

  it('still checks every value given, and the branch', async () => {
    const before = await t.prisma.rateCardDraft.count();
    await create({ idempotencyKey: draftKey() }).expect(400);
    await create({ idempotencyKey: draftKey(), branchId: dxb, price: '-1' }).expect(400);
    await create({ idempotencyKey: draftKey(), branchId: dxb, currency: 'ZZZ' }).expect(400);
    await create({
      idempotencyKey: draftKey(),
      branchId: dxb,
      destinationLocationId: randomUUID(),
    }).expect(400);
    const jed = await branchId(t.prisma, 'JED');
    await create({ idempotencyKey: draftKey(), branchId: jed }).expect(403);
    expect(await t.prisma.rateCardDraft.count()).toBe(before);
  });

  it('keeps the staff member’s words only for values the reviewer did not change', async () => {
    const { id } = summary(
      await create({
        idempotencyKey: draftKey(),
        branchId: dxb,
        price: '900',
        currency: 'USD',
        evidence: [
          { field: 'price', quote: 'nine hundred' },
          { field: 'currency', quote: 'dollars' },
        ],
      }).expect(201),
    );
    expectIncomplete(
      await r.post(`/rate-card-drafts/${id}/approve`, cookies.salesDxb, {
        version: 1,
        confirmed: ['price', 'currency'],
      }),
      RATE_MISSING.filter((f) => f !== 'price' && f !== 'currency'),
    );
    const filled = (
      await r
        .patch(`/rate-card-drafts/${id}`, cookies.salesDxb, {
          version: 1,
          originLocationId: jebelAli,
          destinationLocationId: portSudan,
          mode: 'SEA',
          cargoType: 'GENERAL',
          unit: 'PER_SHIPMENT',
          price: '950',
          currency: 'USD',
          validFrom: nextRateDay(),
        })
        .expect(200)
    ).body as RateCardDraftDto;
    // The price is the reviewer's own now; the currency was left as it was.
    expect(filled).toMatchObject({ version: 2, missingFields: [], check: { ok: true } });
    expect(filled.evidence).toEqual([{ field: 'currency', quote: 'dollars' }]);
    await r
      .post(`/rate-card-drafts/${id}/approve`, cookies.salesDxb, {
        version: 2,
        confirmed: ['price', 'currency'],
      })
      .expect(400);
    const approved = (
      await r
        .post(`/rate-card-drafts/${id}/approve`, cookies.salesDxb, {
          version: 2,
          confirmed: ['currency'],
        })
        .expect(200)
    ).body as RateCardDraftDto;
    expect(approved.status).toBe('APPROVED');
    expect(approved.rateCardId).not.toBeNull();
  });

  it('edits only an open draft of the branches held, with the permission, at its version', async () => {
    const { id } = summary(await create({ idempotencyKey: draftKey(), branchId: dxb }).expect(201));
    const edit = (cookie: string, body: object) => r.patch(`/rate-card-drafts/${id}`, cookie, body);
    await edit(cookies.salesJed, { version: 1, notes: 'x' }).expect(404);
    await edit(cookies.opsDxb, { version: 1, notes: 'x' }).expect(403);
    await edit(cookies.salesDxb, { version: 2, notes: 'x' }).expect(409);
    await edit(cookies.salesDxb, { version: 1, price: 'ten' }).expect(400);
    await edit(cookies.salesDxb, { version: 1, mode: 'AIR' }).expect(400);
    await edit(cookies.salesDxb, { version: 1, branchId: dxb }).expect(400);
    await r
      .post(`/rate-card-drafts/${id}/reject`, cookies.salesDxb, { version: 1, reason: 'No' })
      .expect(200);
    await edit(cookies.salesDxb, { version: 2, notes: 'x' }).expect(409);
  });
});

// -------------------------------------------------------------------------------------------
// Quotations
// -------------------------------------------------------------------------------------------

const QUOTATION_MISSING = [
  'originLocationId',
  'destinationLocationId',
  'mode',
  'cargoType',
  'currency',
  'validUntil',
  'lines',
];

describe('quotation drafts with missing values', () => {
  const create = (body: object) => r.agentPost('/quotation-drafts', tokens.sales, body);
  const read = async (id: string) =>
    (await r.get(`/quotation-drafts/${id}`, cookies.salesDxb).expect(200))
      .body as QuotationDraftDto;

  it('saves a draft with only its customer, and names what it and its lines miss', async () => {
    const body = { idempotencyKey: draftKey(), customerId: customer.id };
    const created = summary(await create(body).expect(201));
    expect(created.missingFields).toEqual(QUOTATION_MISSING);
    const draft = await read(created.id);
    expect(draft).toMatchObject({
      branchId: dxb,
      missingFields: QUOTATION_MISSING,
      check: null,
      pricing: null,
      actions: { canEdit: true, canDecide: true },
    });
    expect(summary(await create(body).expect(201)).id).toBe(created.id);
    // A line without its quantity, and one priced by hand without its charge type and unit.
    const lines = summary(
      await create({
        idempotencyKey: draftKey(),
        customerId: customer.id,
        currency: 'USD',
        lines: [
          { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT' },
          { quantity: '1', unitPrice: '5' },
        ],
      }).expect(201),
    );
    expect(lines.missingFields).toEqual([
      ...QUOTATION_MISSING.filter((f) => f !== 'currency' && f !== 'lines'),
      'lines[0].quantity',
      'lines[1].chargeTypeCode',
      'lines[1].unit',
    ]);
  });

  it('still checks every value given, and the customer', async () => {
    const before = await t.prisma.quotationDraft.count();
    await create({ idempotencyKey: draftKey() }).expect(400);
    await create({ idempotencyKey: draftKey(), customerId: jedCustomer.id }).expect(404);
    const base = { idempotencyKey: draftKey(), customerId: customer.id };
    await create({ ...base, validUntil: '2020-01-01' }).expect(400);
    await create({ ...base, idempotencyKey: draftKey(), currency: 'ZZZ' }).expect(400);
    await create({
      ...base,
      idempotencyKey: draftKey(),
      lines: [{ chargeTypeCode: 'NO-SUCH-CHARGE' }],
    }).expect(400);
    await create({
      ...base,
      idempotencyKey: draftKey(),
      lines: [{ rateCardId: randomUUID() }],
    }).expect(400);
    await create({ ...base, idempotencyKey: draftKey(), lines: [{ quantity: '0' }] }).expect(400);
    expect(await t.prisma.quotationDraft.count()).toBe(before);
  });

  it('refuses the approval while values are missing, then approves once filled in', async () => {
    const body = { idempotencyKey: draftKey(), customerId: customer.id, currency: 'USD' };
    const { id } = summary(await create(body).expect(201));
    expectIncomplete(
      await r.post(`/quotation-drafts/${id}/approve`, cookies.salesDxb, {
        version: 1,
        pricingKey: '0'.repeat(64),
      }),
      QUOTATION_MISSING.filter((f) => f !== 'currency'),
    );
    const filled = (
      await r
        .patch(`/quotation-drafts/${id}`, cookies.salesDxb, {
          version: 1,
          originLocationId: jebelAli,
          destinationLocationId: portSudan,
          mode: 'SEA',
          cargoType: 'GENERAL',
          validUntil: inDays(10),
          lines: [
            { chargeTypeCode: 'FREIGHT', unit: 'PER_SHIPMENT', quantity: '2', unitPrice: '100' },
          ],
        })
        .expect(200)
    ).body as QuotationDraftDto;
    expect(filled).toMatchObject({
      version: 2,
      missingFields: [],
      check: { ok: true, total: '200' },
    });
    const pricingKey = filled.pricing?.key ?? '';
    const approved = (
      await r
        .post(`/quotation-drafts/${id}/approve`, cookies.salesDxb, { version: 2, pricingKey })
        .expect(200)
    ).body as QuotationDraftDto;
    expect(approved.status).toBe('APPROVED');
    expect(approved.quotationId).not.toBeNull();
    expect(summary(await create(body).expect(201))).toMatchObject({ id, status: 'APPROVED' });
  });

  it('refuses an approval from the assistant chat while values are missing', async () => {
    await r
      .put(`/users/${ids.salesAgent}/assistant-approvals`, cookies.admin, { kinds: ['quotation'] })
      .expect(200);
    const { id } = summary(
      await create({ idempotencyKey: draftKey(), customerId: customer.id }).expect(201),
    );
    const card = (await r.agentGet(`/quotation-drafts/${id}/assistant`, tokens.sales).expect(200))
      .body as AssistantDraftDto<QuotationDraftDto>;
    expectIncomplete(
      await r.agentPost(`/quotation-drafts/${id}/assistant-approve`, tokens.sales, {
        version: 1,
        contentHash: card.contentHash,
      }),
      QUOTATION_MISSING,
    );
    expect((await read(id)).status).toBe('DRAFT');
  });

  it('edits only an open draft of the branches held, with the permission, at its version', async () => {
    const { id } = summary(
      await create({ idempotencyKey: draftKey(), customerId: customer.id }).expect(201),
    );
    const edit = (cookie: string, body: object) => r.patch(`/quotation-drafts/${id}`, cookie, body);
    await edit(cookies.salesJed, { version: 1, terms: 'x' }).expect(404);
    await edit(cookies.opsDxb, { version: 1, terms: 'x' }).expect(403);
    await edit(cookies.salesDxb, { version: 2, terms: 'x' }).expect(409);
    await edit(cookies.salesDxb, { version: 1, customerId: jedCustomer.id }).expect(400);
    await edit(cookies.salesDxb, { version: 1, validUntil: 'soon' }).expect(400);
    await edit(cookies.salesDxb, { version: 1, lines: [{ quantity: '-1' }] }).expect(400);
    await r
      .post(`/quotation-drafts/${id}/reject`, cookies.salesDxb, { version: 1, reason: 'No' })
      .expect(200);
    await edit(cookies.salesDxb, { version: 2, terms: 'x' }).expect(409);
  });
});

// -------------------------------------------------------------------------------------------
// Bookings
// -------------------------------------------------------------------------------------------

const BOOKING_MISSING = [
  'originLocationId',
  'destinationLocationId',
  'mode',
  'cargoType',
  'services',
];

describe('booking drafts with missing values', () => {
  const create = (body: object) => r.agentPost('/booking-drafts', tokens.ops, body);
  const read = async (id: string) =>
    (await r.get(`/booking-drafts/${id}`, cookies.opsDxb).expect(200)).body as BookingDraftDto;

  it('saves a direct draft with only its customer, and names what it and its lines miss', async () => {
    const body = { idempotencyKey: draftKey(), customerId: customer.id };
    const created = summary(await create(body).expect(201));
    expect(created.missingFields).toEqual(BOOKING_MISSING);
    const draft = await read(created.id);
    expect(draft).toMatchObject({
      branchId: dxb,
      missingFields: BOOKING_MISSING,
      check: null,
      actions: { canEdit: true, canDecide: true },
    });
    expect(draft.request).toMatchObject({ originLocationId: null, services: [], items: [] });
    expect(summary(await create(body).expect(201)).id).toBe(created.id);
    const items = summary(
      await create({
        idempotencyKey: draftKey(),
        customerId: customer.id,
        services: ['MAIN_FREIGHT'],
        items: [
          { weightKg: '10' },
          { cargoType: 'CONTAINER', quantity: 1 },
          { lengthCm: '10', quantity: 1, cargoType: 'GENERAL' },
        ],
      }).expect(201),
    );
    expect(items.missingFields).toEqual([
      ...BOOKING_MISSING.filter((f) => f !== 'services'),
      'items[0].cargoType',
      'items[0].quantity',
      'items[1].containerTypeCode',
      'items[2].widthCm',
      'items[2].heightCm',
    ]);
  });

  it('still checks every value given, and the customer', async () => {
    const before = await t.prisma.bookingDraft.count();
    await create({ idempotencyKey: draftKey() }).expect(400);
    await create({ idempotencyKey: draftKey(), customerId: jedCustomer.id }).expect(404);
    const base = { customerId: customer.id };
    await create({ ...base, idempotencyKey: draftKey(), mode: 'AIR' }).expect(400);
    await create({ ...base, idempotencyKey: draftKey(), shipperId: randomUUID() }).expect(400);
    await create({
      ...base,
      idempotencyKey: draftKey(),
      items: [{ containerTypeCode: 'NOPE' }],
    }).expect(400);
    await create({ ...base, idempotencyKey: draftKey(), items: [{ quantity: 0 }] }).expect(400);
    await create({
      ...base,
      idempotencyKey: draftKey(),
      originLocationId: jebelAli,
      destinationLocationId: jebelAli,
    }).expect(400);
    expect(await t.prisma.bookingDraft.count()).toBe(before);
  });

  it('refuses the approval while values are missing, then approves once filled in', async () => {
    const body = { idempotencyKey: draftKey(), customerId: customer.id, mode: 'SEA' };
    const { id } = summary(await create(body).expect(201));
    const missing = BOOKING_MISSING.filter((f) => f !== 'mode');
    expectIncomplete(
      await r.post(`/booking-drafts/${id}/approve`, cookies.opsDxb, { version: 1 }),
      missing,
    );
    const filled = (
      await r
        .patch(`/booking-drafts/${id}`, cookies.opsDxb, {
          version: 1,
          originLocationId: jebelAli,
          destinationLocationId: portSudan,
          cargoType: 'GENERAL',
          services: ['MAIN_FREIGHT'],
          items: [{ cargoType: 'GENERAL', quantity: 3 }],
        })
        .expect(200)
    ).body as BookingDraftDto;
    expect(filled).toMatchObject({ version: 2, missingFields: [], check: { ok: true } });
    const approved = (
      await r.post(`/booking-drafts/${id}/approve`, cookies.opsDxb, { version: 2 }).expect(200)
    ).body as BookingDraftDto;
    expect(approved.status).toBe('APPROVED');
    expect(approved.bookingId).not.toBeNull();
    expect(summary(await create(body).expect(201))).toMatchObject({ id, status: 'APPROVED' });
  });

  it('refuses an approval from the assistant chat while values are missing', async () => {
    await r
      .put(`/users/${ids.opsAgent}/assistant-approvals`, cookies.admin, {
        kinds: ['trip', 'booking'],
      })
      .expect(200);
    const { id } = summary(
      await create({ idempotencyKey: draftKey(), customerId: customer.id }).expect(201),
    );
    const card = (await r.agentGet(`/booking-drafts/${id}/assistant`, tokens.ops).expect(200))
      .body as AssistantDraftDto<BookingDraftDto>;
    expectIncomplete(
      await r.agentPost(`/booking-drafts/${id}/assistant-approve`, tokens.ops, {
        version: 1,
        contentHash: card.contentHash,
      }),
      BOOKING_MISSING,
    );
  });

  it('edits only an open draft of the branches held, with the permission, at its version', async () => {
    const { id } = summary(
      await create({ idempotencyKey: draftKey(), customerId: customer.id }).expect(201),
    );
    const edit = (cookie: string, body: object) => r.patch(`/booking-drafts/${id}`, cookie, body);
    await edit(cookies.opsJed, { version: 1, specialInstructions: 'x' }).expect(404);
    await edit(cookies.whDxb, { version: 1, specialInstructions: 'x' }).expect(403);
    await edit(cookies.opsDxb, { version: 2, specialInstructions: 'x' }).expect(409);
    await edit(cookies.opsDxb, { version: 1, customerId: jedCustomer.id }).expect(400);
    await edit(cookies.opsDxb, { version: 1, services: ['TELEPORT'] }).expect(400);
    await edit(cookies.opsDxb, { version: 1, items: [{ quantity: 1.5 }] }).expect(400);
    await r
      .post(`/booking-drafts/${id}/reject`, cookies.opsDxb, { version: 1, reason: 'No' })
      .expect(200);
    await edit(cookies.opsDxb, { version: 2, specialInstructions: 'x' }).expect(409);
  });
  // Codex on 98f9727 (P1): a container named in a draft still missing values was not checked, so
  // a cancelled container of another branch, which GET refuses, was stored and then shown on the
  // draft (its number and ETD). A container named is now checked as a reference on every create
  // and edit (the user may book into it: it exists and is open; any branch's open container is
  // the one cross-branch case), whatever else is missing; whether the booking fits it waits for
  // the booking's route and cargo.
  describe('a container named in a draft still missing values', () => {
    let jed: string;
    beforeAll(async () => {
      jed = await branchId(t.prisma, 'JED');
    });

    // Another branch's container the user may not read directly is not found, as GET says.
    it('refuses a cancelled container of another branch, or of its own, and an unknown one; nothing is written', async () => {
      const foreign = await containerOf(jed, cookies.opsJed, true);
      await r.get(`/consolidations/${foreign.id}`, cookies.opsDxb).expect(404);
      const own = await containerOf(dxb, cookies.opsDxb, true);
      const before = await t.prisma.bookingDraft.count();
      for (const [id, status, refusal] of [
        [foreign.id, 404, undefined],
        [own.id, 409, 'CONTAINER_NOT_OPEN'],
        [randomUUID(), 404, undefined],
      ] as const) {
        const res = await create({
          idempotencyKey: draftKey(),
          customerId: customer.id,
          consolidationId: id,
        });
        expect(res.status, id).toBe(status);
        expect(code(res)).toBe(refusal);
        // The pre-check says the same, and names no container data.
        const checked = (
          await r
            .agentPost('/booking-drafts/check', tokens.ops, {
              customerId: customer.id,
              consolidationId: id,
            })
            .expect(200)
        ).body as DraftPreCheckDto;
        expect(checked.ok, id).toBe(false);
        expect(JSON.stringify(checked)).not.toContain('ZZ MF Vessel');
      }
      expect(await t.prisma.bookingDraft.count()).toBe(before);
    });

    it('an edit naming such a container is refused, and the draft is not changed', async () => {
      const foreign = await containerOf(jed, cookies.opsJed, true);
      const { id } = summary(
        await create({ idempotencyKey: draftKey(), customerId: customer.id }).expect(201),
      );
      const edit = (consolidationId: string) =>
        r.patch(`/booking-drafts/${id}`, cookies.opsDxb, { version: 1, consolidationId });
      const refused = await edit(foreign.id);
      expect(refused.status).toBe(404);
      expect(JSON.stringify(refused.body)).not.toContain(foreign.number);
      await edit(randomUUID()).expect(404);
      const draft = await read(id);
      expect(draft).toMatchObject({ version: 1, container: null });
      expect(draft.request).not.toHaveProperty('consolidationId');
    });

    it("takes another branch's open container (the one cross-branch case) and shows it", async () => {
      const open = await containerOf(jed, cookies.opsJed);
      const { id } = summary(
        await create({
          idempotencyKey: draftKey(),
          customerId: customer.id,
          consolidationId: open.id,
        }).expect(201),
      );
      expect((await read(id)).container).toMatchObject({ id: open.id, number: open.number });
    });

    it('shows nothing of a container a draft holds that the reader could not read directly', async () => {
      const open = await containerOf(jed, cookies.opsJed);
      const { id } = summary(
        await create({
          idempotencyKey: draftKey(),
          customerId: customer.id,
          consolidationId: open.id,
        }).expect(201),
      );
      // Cancelled since by its branch: the draft's reader may no longer read it directly.
      await r
        .post(`/consolidations/${open.id}/cancel`, cookies.opsJed, { reason: 'Test' })
        .expect(200);
      await r.get(`/consolidations/${open.id}`, cookies.opsDxb).expect(404);
      const draft = await read(id);
      expect(draft.container).toBeNull();
      expect(JSON.stringify(draft)).not.toContain('ZZ MF Vessel');
      expect(JSON.stringify(draft)).not.toContain(open.number);
    });
  });
});
