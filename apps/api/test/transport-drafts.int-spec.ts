import { randomInt } from 'node:crypto';
import type {
  AgentClientCreatedDto,
  BookingDto,
  CarrierDto,
  CustomerDto,
  DriverDto,
  EntryDraftSummaryDto,
  GoodsReleaseDraftDto,
  GoodsReleaseDraftListItemDto,
  ShipmentDto,
  TripDraftDto,
  TripDraftListItemDto,
  TripDto,
  VehicleDto,
  WarehouseDto,
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

// Trip and goods release drafts proposed by the staff assistant (entry drafts). The assistant's
// users (agent-it-) create drafts; it- users approve them, so the trips and release notes they
// create are removed by the usual cleanup.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let portSudan: string;
let khartoum: string;
let customer: CustomerDto;
let vehicle: VehicleDto;
let driver: DriverDto;
let carrier: CarrierDto;
let warehouse: WarehouseDto;
let jedWarehouse: WarehouseDto;

const cookies = {
  admin: '',
  opsDxb: '',
  opsJed: '',
  salesDxb: '',
  whDxb: '',
  whJed: '',
  driverDxb: '',
  driverOpsDxb: '',
};
const agentCookies = { opsAgent: '', whAgent: '', salesAgent: '', opsJedAgent: '' };
const tokens = { ops: '', wh: '', sales: '', opsJed: '' };

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

function tripRequest(shipmentIds: string[], extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    branchId: dxb,
    kind: 'OWN',
    originLocationId: portSudan,
    destinationLocationId: khartoum,
    vehicleId: vehicle.id,
    driverId: driver.id,
    plannedDeparture: '2030-01-01T06:00:00Z',
    notes: 'Morning run',
    shipmentIds,
    ...extra,
  };
}

const createTripDraft = (body: object, token = tokens.ops) =>
  r.agentPost('/trip-drafts', token, body);

async function tripDraft(body: object): Promise<TripDraftDto> {
  const created = (await createTripDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/trip-drafts/${created.id}`, cookies.opsDxb).expect(200))
    .body as TripDraftDto;
}

/** A shipment with `packages` received into the DXB warehouse. */
async function heldShipment(packages = 4): Promise<ShipmentDto> {
  const shipment = await roadShipment();
  await r
    .post(`/shipments/${shipment.id}/warehouse/receipts`, cookies.whDxb, {
      warehouseId: warehouse.id,
      packages,
      condition: 'GOOD',
    })
    .expect(201);
  return shipment;
}

function releaseRequest(shipmentId: string, extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    shipmentId,
    warehouseId: warehouse.id,
    packages: 3,
    weightKg: '300.50',
    partyName: 'Driver Ahmed',
    note: 'Collect at gate 2',
    ...extra,
  };
}

const createReleaseDraft = (body: object, token = tokens.wh) =>
  r.agentPost('/release-drafts', token, body);

async function releaseDraft(body: object): Promise<GoodsReleaseDraftDto> {
  const created = (await createReleaseDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/release-drafts/${created.id}`, cookies.whDxb).expect(200))
    .body as GoodsReleaseDraftDto;
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
  const jed = await branchId(t.prisma, 'JED');
  const loc = async (code: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
  portSudan = await loc('SDPZU');
  khartoum = await loc('SDKRT');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB']),
    opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED']),
    salesDxb: await createUser(t.prisma, ['SALES'], ['DXB']),
    whDxb: await createUser(t.prisma, ['WAREHOUSE'], ['DXB']),
    whJed: await createUser(t.prisma, ['WAREHOUSE'], ['JED']),
    driverDxb: await createUser(t.prisma, ['DRIVER'], ['DXB']),
    driverOpsDxb: await createUser(t.prisma, ['DRIVER', 'OPERATIONS'], ['DXB']),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const assistantUsers = {
    opsAgent: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
    whAgent: await createUser(t.prisma, ['WAREHOUSE'], ['DXB'], AGENT_PREFIX),
    salesAgent: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    opsJedAgent: await createUser(t.prisma, ['OPERATIONS'], ['JED'], AGENT_PREFIX),
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  client = await registerClient(t, cookies.admin, 'Transport draft platform');
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);
  tokens.wh = await tokenFor(t, agentCookies.whAgent, client);
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.opsJed = await tokenFor(t, agentCookies.opsJedAgent, client);

  customer = (
    await r
      .post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Transport Draft Test Trading',
        phone: uniquePhone(),
      })
      .expect(201)
  ).body as CustomerDto;
  const suffix = String(randomInt(100_000, 999_999));
  vehicle = (
    await r
      .post('/transport/vehicles', cookies.opsDxb, {
        branchId: dxb,
        plateNumber: `ZZ TD ${suffix}`,
        vehicleType: 'Flatbed trailer',
      })
      .expect(201)
  ).body as VehicleDto;
  driver = (
    await r
      .post('/transport/drivers', cookies.opsDxb, { branchId: dxb, name: `ZZ Driver ${suffix}` })
      .expect(201)
  ).body as DriverDto;
  carrier = (
    await r
      .post('/transport/carriers', cookies.opsDxb, { name: `ZZ Carrier ${suffix}` })
      .expect(201)
  ).body as CarrierDto;
  warehouse = (
    await r
      .post('/warehouses', cookies.whDxb, {
        branchId: dxb,
        code: `ZZ-TD-${suffix}`,
        nameEn: 'Draft test store',
        nameAr: 'مستودع اختبار المسودات',
      })
      .expect(201)
  ).body as WarehouseDto;
  jedWarehouse = (
    await r
      .post('/warehouses', cookies.whJed, {
        branchId: jed,
        code: `ZZ-TDJ-${suffix}`,
        nameEn: 'Draft test JED store',
        nameAr: 'مستودع اختبار جدة',
      })
      .expect(201)
  ).body as WarehouseDto;
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('trip drafts: the assistant proposes', () => {
  it('creates a draft, gets back ids and counts only, and plans nothing yet', async () => {
    const shipment = await roadShipment();
    const res = await createTripDraft(tripRequest([shipment.id])).expect(201);
    const body = res.body as EntryDraftSummaryDto;
    expect(body).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lineCount', 'status', 'version'].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('Morning run');
    expect(await t.prisma.tripShipment.count({ where: { shipmentId: shipment.id } })).toBe(0);
    const s = await t.prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(s.status).toBe(shipment.status);
  });

  it('returns the same draft for a repeat, and refuses the key with another request', async () => {
    const shipment = await roadShipment();
    const body = tripRequest([shipment.id]);
    const first = (await createTripDraft(body).expect(201)).body as EntryDraftSummaryDto;
    // Same request in another canonical form: upper-case ids, the same time in another offset.
    const again = {
      ...body,
      vehicleId: vehicle.id.toUpperCase(),
      plannedDeparture: '2030-01-01T10:00:00+04:00',
    };
    const second = (await createTripDraft(again).expect(201)).body as EntryDraftSummaryDto;
    expect(second.id).toBe(first.id);
    await createTripDraft({ ...body, notes: 'Evening run' }).expect(409);
    const found = await r.agentGet(`/trip-drafts/by-key/${body.idempotencyKey}`, tokens.ops);
    expect((found.body as EntryDraftSummaryDto).id).toBe(first.id);
    await r.agentGet(`/trip-drafts/by-key/${body.idempotencyKey}`, tokens.opsJed).expect(404);
  });

  it('refuses another branch, a missing permission and what NOLON would refuse', async () => {
    const shipment = await roadShipment();
    const before = await t.prisma.tripDraft.count();
    // The trip's branch is not the user's.
    await createTripDraft(tripRequest([shipment.id]), tokens.opsJed).expect(403);
    // Sales may view trips but not plan them; warehouse neither.
    await createTripDraft(tripRequest([shipment.id]), tokens.sales).expect(403);
    await createTripDraft(tripRequest([shipment.id]), tokens.wh).expect(403);
    // Origin and destination the same, an unknown shipment, an unknown field, a short key.
    await createTripDraft(tripRequest([shipment.id], { destinationLocationId: portSudan })).expect(
      400,
    );
    await createTripDraft(tripRequest([customer.id])).expect(404);
    await createTripDraft({ ...tripRequest([shipment.id]), status: 'COMPLETED' }).expect(400);
    await createTripDraft({ ...tripRequest([shipment.id]), idempotencyKey: 'short' }).expect(400);
    expect(await t.prisma.tripDraft.count()).toBe(before);
  });

  it('cannot read, approve or reject drafts, nor plan a trip itself', async () => {
    const shipment = await roadShipment();
    const draft = await tripDraft(tripRequest([shipment.id]));
    await r.agentGet('/trip-drafts', tokens.ops).expect(403);
    await r.agentGet(`/trip-drafts/${draft.id}`, tokens.ops).expect(403);
    await r.agentPost(`/trip-drafts/${draft.id}/approve`, tokens.ops, { version: 1 }).expect(403);
    await r
      .agentPost(`/trip-drafts/${draft.id}/reject`, tokens.ops, { version: 1, reason: 'x' })
      .expect(403);
    const plain: Record<string, unknown> = tripRequest([shipment.id]);
    delete plain.idempotencyKey;
    await r.agentPost('/trips', tokens.ops, plain).expect(403);
    // A person with a session cannot create drafts.
    await r.post('/trip-drafts', cookies.opsDxb, tripRequest([shipment.id])).expect(403);
  });
});

describe('trip drafts: a person reviews', () => {
  it('shows drafts of their branches only, with the route and shipment numbers', async () => {
    const shipment = await roadShipment();
    const draft = await tripDraft(tripRequest([shipment.id]));
    expect(draft).toMatchObject({
      subject: 'SDPZU → SDKRT',
      vehiclePlate: vehicle.plateNumber,
      driverName: driver.name,
      carrierName: null,
      shipmentNumbers: [shipment.number],
      check: { ok: true, total: null, currency: null },
      actions: { canEdit: false, canDecide: true },
    });
    expect(draft.request).toMatchObject({
      plannedDeparture: '2030-01-01T06:00:00.000Z',
      shipmentIds: [shipment.id],
    });
    const list = (await r.get('/trip-drafts?status=DRAFT', cookies.opsDxb).expect(200))
      .body as TripDraftListItemDto[];
    expect(list.map((d) => d.id)).toContain(draft.id);
    const jed = (await r.get('/trip-drafts', cookies.opsJed).expect(200))
      .body as TripDraftListItemDto[];
    expect(jed.map((d) => d.id)).not.toContain(draft.id);
    await r.get(`/trip-drafts/${draft.id}`, cookies.opsJed).expect(404);
    // Sales sees trips but cannot plan them, so cannot decide.
    const sales = (await r.get(`/trip-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as TripDraftDto;
    expect(sales.actions.canDecide).toBe(false);
  });

  it('shows no draft to a Driver-only user, who sees only their own trips', async () => {
    const shipment = await roadShipment();
    const draft = await tripDraft(tripRequest([shipment.id]));
    // A Driver has trips:view, limited to the trips assigned to them; a draft is no one's yet.
    await r.get('/trip-drafts', cookies.driverDxb).expect(403);
    await r.get(`/trip-drafts/${draft.id}`, cookies.driverDxb).expect(403);
    await r
      .post(`/trip-drafts/${draft.id}/approve`, cookies.driverDxb, { version: draft.version })
      .expect(403);
    await r
      .post(`/trip-drafts/${draft.id}/reject`, cookies.driverDxb, {
        version: draft.version,
        reason: 'no',
      })
      .expect(403);
    // Another role that grants trips lifts the limit, as it does on trips.
    const list = (await r.get('/trip-drafts', cookies.driverOpsDxb).expect(200))
      .body as TripDraftListItemDto[];
    expect(list.map((d) => d.id)).toContain(draft.id);
    await r.get(`/trip-drafts/${draft.id}`, cookies.driverOpsDxb).expect(200);
  });

  it('gives a Driver-only user no draft list of any kind', async () => {
    for (const path of [
      '/trip-drafts',
      '/release-drafts',
      '/quotation-drafts',
      '/booking-drafts',
    ]) {
      const res = await r.get(path, cookies.driverDxb);
      expect(res.status, path).toBe(403);
    }
  });

  it('shows the agreed cost of an external trip only to those who see transport costs', async () => {
    const shipment = await roadShipment();
    const created = (
      await createTripDraft(
        tripRequest([shipment.id], {
          kind: 'EXTERNAL',
          vehicleId: null,
          driverId: null,
          carrierId: carrier.id,
          agreedCost: '350.50',
          currency: 'USD',
          externalVehicle: 'ZZ 999',
        }),
      ).expect(201)
    ).body as EntryDraftSummaryDto;
    const ops = (await r.get(`/trip-drafts/${created.id}`, cookies.opsDxb).expect(200))
      .body as TripDraftDto;
    expect(ops.request).toMatchObject({ agreedCost: '350.5', currency: 'USD' });
    expect(ops).toMatchObject({
      carrierName: carrier.name,
      vehiclePlate: null,
      check: { ok: true, total: '350.5', currency: 'USD' },
    });
    // Sales sees trips but not their costs (annex A).
    const sales = (await r.get(`/trip-drafts/${created.id}`, cookies.salesDxb).expect(200))
      .body as TripDraftDto;
    expect(sales.request).toMatchObject({ agreedCost: null, currency: null });
    expect(sales.check).toEqual({ ok: true, total: null, currency: null });
    expect(JSON.stringify(sales)).not.toContain('350');
  });

  it('approves into an ordinary PLANNED trip that schedules the shipment, once', async () => {
    const shipment = await roadShipment();
    const draft = await tripDraft(tripRequest([shipment.id]));
    await r.post(`/trip-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 2 }).expect(409);
    const approved = (
      await r.post(`/trip-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 }).expect(200)
    ).body as TripDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', version: 2, check: null });
    expect(approved.tripNumber).toMatch(/^NOL-TRP-/);
    const trip = (await r.get(`/trips/${approved.tripId}`, cookies.opsDxb).expect(200))
      .body as TripDto;
    expect(trip).toMatchObject({ status: 'PLANNED', notes: 'Morning run', vehicleId: vehicle.id });
    const s = await t.prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(s.status).toBe('TRIP_SCHEDULED');
    await r.post(`/trip-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 }).expect(200);
    expect(await t.prisma.tripShipment.count({ where: { shipmentId: shipment.id } })).toBe(1);
  });

  it('refuses approval to another branch or a user who cannot plan trips', async () => {
    const shipment = await roadShipment();
    const draft = await tripDraft(tripRequest([shipment.id]));
    await r.post(`/trip-drafts/${draft.id}/approve`, cookies.opsJed, { version: 1 }).expect(404);
    await r.post(`/trip-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 }).expect(403);
    await r.post(`/trip-drafts/${draft.id}/approve`, cookies.whDxb, { version: 1 }).expect(403);
    const still = (await r.get(`/trip-drafts/${draft.id}`, cookies.opsDxb).expect(200))
      .body as TripDraftDto;
    expect(still.status).toBe('DRAFT');
  });

  it('two concurrent approvals plan one trip', async () => {
    const shipment = await roadShipment();
    const draft = await tripDraft(tripRequest([shipment.id]));
    const results = await Promise.all([
      r.post(`/trip-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 }),
      r.post(`/trip-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 }),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect(await t.prisma.tripShipment.count({ where: { shipmentId: shipment.id } })).toBe(1);
  });

  it('a second draft for a shipment already on a trip is refused under the lock and stays open', async () => {
    const shipment = await roadShipment();
    const first = await tripDraft(tripRequest([shipment.id]));
    const second = await tripDraft(tripRequest([shipment.id]));
    await r.post(`/trip-drafts/${first.id}/approve`, cookies.opsDxb, { version: 1 }).expect(200);
    await r.post(`/trip-drafts/${second.id}/approve`, cookies.opsDxb, { version: 1 }).expect(409);
    const still = (await r.get(`/trip-drafts/${second.id}`, cookies.opsDxb).expect(200))
      .body as TripDraftDto;
    expect(still.status).toBe('DRAFT');
  });

  it('rejects with a reason; expired drafts cannot be decided', async () => {
    const shipment = await roadShipment();
    const draft = await tripDraft(tripRequest([shipment.id]));
    await r.post(`/trip-drafts/${draft.id}/reject`, cookies.opsDxb, { version: 1 }).expect(400);
    const rejected = (
      await r
        .post(`/trip-drafts/${draft.id}/reject`, cookies.opsDxb, {
          version: 1,
          reason: 'Wrong truck',
        })
        .expect(200)
    ).body as TripDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'Wrong truck' });
    await r.post(`/trip-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 2 }).expect(409);

    const old = await tripDraft(tripRequest([shipment.id]));
    await t.prisma.tripDraft.update({
      where: { id: old.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = (await r.get(`/trip-drafts/${old.id}`, cookies.opsDxb).expect(200))
      .body as TripDraftDto;
    expect(expired).toMatchObject({ status: 'EXPIRED', check: null });
    await r.post(`/trip-drafts/${old.id}/approve`, cookies.opsDxb, { version: 1 }).expect(409);
  });

  it('the database keeps a decided draft and its shipments as they are', async () => {
    const shipment = await roadShipment();
    const draft = await tripDraft(tripRequest([shipment.id]));
    await r
      .post(`/trip-drafts/${draft.id}/reject`, cookies.opsDxb, { version: 1, reason: 'No' })
      .expect(200);
    await expect(
      t.prisma.tripDraft.update({ where: { id: draft.id }, data: { notes: 'Changed' } }),
    ).rejects.toThrow(/decided/);
    await expect(
      t.prisma.tripDraftShipment.deleteMany({ where: { draftId: draft.id } }),
    ).rejects.toThrow(/decided/);
    const open = await tripDraft(tripRequest([shipment.id]));
    await expect(
      t.prisma.tripDraftShipment.updateMany({
        where: { draftId: open.id },
        data: { draftId: draft.id },
      }),
    ).rejects.toThrow(/another draft/);
    await expect(
      t.prisma.tripDraft.update({ where: { id: open.id }, data: { state: 'APPROVED' } }),
    ).rejects.toThrow();
  });
});

describe('goods release drafts', () => {
  it('the assistant proposes a release; nothing leaves the warehouse yet', async () => {
    const shipment = await heldShipment();
    const res = await createReleaseDraft(releaseRequest(shipment.id)).expect(201);
    const body = res.body as EntryDraftSummaryDto;
    expect(body).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(JSON.stringify(body)).not.toContain('Driver Ahmed');
    expect(
      await t.prisma.warehouseMovement.count({
        where: { shipmentId: shipment.id, kind: 'RELEASE' },
      }),
    ).toBe(0);
    // Repeat and key reuse.
    const body2 = releaseRequest(shipment.id);
    const a = (await createReleaseDraft(body2).expect(201)).body as EntryDraftSummaryDto;
    const b = (await createReleaseDraft({ ...body2, weightKg: '300.5' }).expect(201))
      .body as EntryDraftSummaryDto;
    expect(b.id).toBe(a.id);
    await createReleaseDraft({ ...body2, packages: 2 }).expect(409);
  });

  it('refuses another branch, a missing permission, a time and an unknown field', async () => {
    const shipment = await heldShipment();
    const before = await t.prisma.goodsReleaseDraft.count();
    await createReleaseDraft(releaseRequest(shipment.id), tokens.opsJed).expect(403);
    await createReleaseDraft(releaseRequest(shipment.id), tokens.sales).expect(403);
    // A warehouse of another branch.
    await createReleaseDraft(releaseRequest(shipment.id, { warehouseId: jedWarehouse.id })).expect(
      404,
    );
    // The release is dated at the approval: the assistant cannot backdate it.
    await createReleaseDraft(
      releaseRequest(shipment.id, { occurredAt: '2026-01-01T00:00:00Z' }),
    ).expect(400);
    await createReleaseDraft({ ...releaseRequest(shipment.id), approved: true }).expect(400);
    await createReleaseDraft(releaseRequest(shipment.id, { packages: 0 })).expect(400);
    expect(await t.prisma.goodsReleaseDraft.count()).toBe(before);
  });

  it('cannot read or decide drafts, nor release goods itself', async () => {
    const shipment = await heldShipment();
    const draft = await releaseDraft(releaseRequest(shipment.id));
    await r.agentGet('/release-drafts', tokens.wh).expect(403);
    await r.agentGet(`/release-drafts/${draft.id}`, tokens.wh).expect(403);
    await r.agentPost(`/release-drafts/${draft.id}/approve`, tokens.wh, { version: 1 }).expect(403);
    await r
      .agentPost(`/shipments/${shipment.id}/warehouse/releases`, tokens.wh, {
        warehouseId: warehouse.id,
        packages: 1,
      })
      .expect(403);
    await r.post('/release-drafts', cookies.whDxb, releaseRequest(shipment.id)).expect(403);
  });

  it('a person reviews and approves it into an ordinary release note, once', async () => {
    const shipment = await heldShipment();
    const draft = await releaseDraft(releaseRequest(shipment.id));
    expect(draft).toMatchObject({
      subject: shipment.number,
      shipmentNumber: shipment.number,
      warehouseCode: warehouse.code,
      check: { ok: true, total: null, currency: null },
      actions: { canEdit: false, canDecide: true },
    });
    expect(draft.request).toMatchObject({ packages: 3, weightKg: '300.5' });
    const list = (await r.get('/release-drafts?status=DRAFT', cookies.whDxb).expect(200))
      .body as GoodsReleaseDraftListItemDto[];
    expect(list.find((d) => d.id === draft.id)).toMatchObject({ packages: 3 });
    const jed = (await r.get('/release-drafts', cookies.whJed).expect(200))
      .body as GoodsReleaseDraftListItemDto[];
    expect(jed.map((d) => d.id)).not.toContain(draft.id);
    await r.get(`/release-drafts/${draft.id}`, cookies.whJed).expect(404);
    // Sales sees warehouse records but cannot release goods.
    const sales = (await r.get(`/release-drafts/${draft.id}`, cookies.salesDxb).expect(200))
      .body as GoodsReleaseDraftDto;
    expect(sales.actions.canDecide).toBe(false);
    await r
      .post(`/release-drafts/${draft.id}/approve`, cookies.salesDxb, { version: 1 })
      .expect(403);
    await r.post(`/release-drafts/${draft.id}/approve`, cookies.whJed, { version: 1 }).expect(404);

    const approved = (
      await r.post(`/release-drafts/${draft.id}/approve`, cookies.whDxb, { version: 1 }).expect(200)
    ).body as GoodsReleaseDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', check: null });
    const movement = await t.prisma.warehouseMovement.findUniqueOrThrow({
      where: { id: approved.movementId! },
    });
    expect(movement).toMatchObject({ kind: 'RELEASE', packages: 3, partyName: 'Driver Ahmed' });
    expect(movement.number).toBe(approved.movementNumber);
    await r.post(`/release-drafts/${draft.id}/approve`, cookies.whDxb, { version: 1 }).expect(200);
    expect(
      await t.prisma.warehouseMovement.count({
        where: { shipmentId: shipment.id, kind: 'RELEASE' },
      }),
    ).toBe(1);
  });

  it('refuses releasing more than the warehouse holds, under the lock, and leaves the draft open', async () => {
    const shipment = await heldShipment(4);
    const first = await releaseDraft(releaseRequest(shipment.id, { packages: 3 }));
    const second = await releaseDraft(releaseRequest(shipment.id, { packages: 3 }));
    const results = await Promise.all([
      r.post(`/release-drafts/${first.id}/approve`, cookies.whDxb, { version: 1 }),
      r.post(`/release-drafts/${second.id}/approve`, cookies.whDxb, { version: 1 }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(
      await t.prisma.warehouseMovement.count({
        where: { shipmentId: shipment.id, kind: 'RELEASE' },
      }),
    ).toBe(1);
    const states = await t.prisma.goodsReleaseDraft.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { state: true },
    });
    expect(states.map((s) => s.state).sort()).toEqual(['APPROVED', 'DRAFT']);
  });

  it('rejects with a reason; the database keeps decided drafts as they are', async () => {
    const shipment = await heldShipment();
    const draft = await releaseDraft(releaseRequest(shipment.id));
    const rejected = (
      await r
        .post(`/release-drafts/${draft.id}/reject`, cookies.whDxb, {
          version: 1,
          reason: 'Customer did not pay',
        })
        .expect(200)
    ).body as GoodsReleaseDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'Customer did not pay' });
    await r.post(`/release-drafts/${draft.id}/approve`, cookies.whDxb, { version: 2 }).expect(409);
    await expect(
      t.prisma.goodsReleaseDraft.update({ where: { id: draft.id }, data: { packages: 1 } }),
    ).rejects.toThrow(/decided/);
  });
});
