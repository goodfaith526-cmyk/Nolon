import type {
  AgentClientCreatedDto,
  BookingDto,
  CustomerDto,
  DriverDto,
  DraftPreCheckDto,
  EntryDraftSummaryDto,
  ShipmentDto,
  ShipmentStatusDraftDto,
  ShipmentStatusDraftListItemDto,
  VehicleDto,
} from '@nolon/shared';
import { randomInt } from 'node:crypto';
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
  expectGateRefusal,
  registerClient,
  requests,
  tokenFor,
} from './agent-drafts-helpers.js';
import { deleteCommercialTestData, uniquePhone } from './test-data.js';

// Shipment status drafts proposed by the staff assistant (entry drafts). The assistant's users
// (agent-it-) create drafts; it- users decide them, so the shipments they move are removed by the
// usual cleanup.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let portSudan: string;
let khartoum: string;
let customer: CustomerDto;

const cookies = {
  admin: '',
  opsDxb: '',
  opsJed: '',
  salesDxb: '',
  whDxb: '',
  driverDxb: '',
  driverOpsDxb: '',
};
let driverUserId: string;
const agentCookies = { opsAgent: '', salesAgent: '', opsJedAgent: '' };
const tokens = { ops: '', sales: '', opsJed: '' };

/** A confirmed road booking (with warehousing) of the DXB customer; its shipment, CREATED. */
async function roadShipment(): Promise<ShipmentDto> {
  const booking = (
    await r
      .post('/bookings', cookies.opsDxb, {
        customerId: customer.id,
        originLocationId: portSudan,
        destinationLocationId: khartoum,
        mode: 'ROAD',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT', 'WAREHOUSE'],
        items: [{ cargoType: 'GENERAL', quantity: 4, weightKg: '400' }],
      })
      .expect(201)
  ).body as BookingDto;
  const confirmed = (await r.post(`/bookings/${booking.id}/confirm`, cookies.opsDxb).expect(200))
    .body as BookingDto;
  return (await r.get(`/shipments/${confirmed.shipmentId}`, cookies.opsDxb).expect(200))
    .body as ShipmentDto;
}

function statusRequest(shipmentId: string, extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    shipmentId,
    status: 'TRIP_SCHEDULED',
    locationId: portSudan,
    note: 'Truck booked for Sunday',
    ...extra,
  };
}

const createDraft = (body: object, token = tokens.ops) =>
  r.agentPost('/shipment-status-drafts', token, body);

async function statusDraft(body: object): Promise<ShipmentStatusDraftDto> {
  const created = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
  return (await r.get(`/shipment-status-drafts/${created.id}`, cookies.opsDxb).expect(200))
    .body as ShipmentStatusDraftDto;
}

async function shipmentStatus(id: string): Promise<string> {
  return (await t.prisma.shipment.findUniqueOrThrow({ where: { id } })).status;
}

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
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
    driverDxb: await createUser(t.prisma, ['DRIVER'], ['DXB']),
    driverOpsDxb: await createUser(t.prisma, ['DRIVER', 'OPERATIONS'], ['DXB']),
  };
  driverUserId = people.driverDxb.id;
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  const assistantUsers = {
    opsAgent: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], AGENT_PREFIX),
    salesAgent: await createUser(t.prisma, ['SALES'], ['DXB'], AGENT_PREFIX),
    opsJedAgent: await createUser(t.prisma, ['OPERATIONS'], ['JED'], AGENT_PREFIX),
  };
  for (const key of Object.keys(assistantUsers) as (keyof typeof assistantUsers)[]) {
    agentCookies[key] = await signIn(t, assistantUsers[key].email);
  }
  client = await registerClient(t, cookies.admin, 'Status draft platform');
  tokens.ops = await tokenFor(t, agentCookies.opsAgent, client);
  tokens.sales = await tokenFor(t, agentCookies.salesAgent, client);
  tokens.opsJed = await tokenFor(t, agentCookies.opsJedAgent, client);
  customer = (
    await r
      .post('/customers', cookies.salesDxb, {
        branchId: dxb,
        kind: 'COMPANY',
        name: 'Status Draft Test Trading',
        phone: uniquePhone(),
      })
      .expect(201)
  ).body as CustomerDto;
});

afterAll(async () => {
  await deleteCommercialTestData(t.prisma);
  await deleteTestUsers(t.prisma);
  await t.close();
});

describe('shipment status drafts: the assistant proposes', () => {
  it('creates a draft and moves nothing yet', async () => {
    const shipment = await roadShipment();
    const res = await createDraft(statusRequest(shipment.id)).expect(201);
    const created = res.body as EntryDraftSummaryDto;
    expect(created).toMatchObject({ status: 'DRAFT', version: 1, lineCount: 1 });
    expect(await shipmentStatus(shipment.id)).toBe('CREATED');
  });

  it('returns the same draft for a repeat, and refuses the key with another request', async () => {
    const shipment = await roadShipment();
    const body = statusRequest(shipment.id);
    const a = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    const b = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(b.id).toBe(a.id);
    const found = (
      await r.agentGet(`/shipment-status-drafts/by-key/${body.idempotencyKey}`, tokens.ops)
    ).body as EntryDraftSummaryDto;
    expect(found.id).toBe(a.id);
    await createDraft({ ...body, note: 'Another note' }).expect(409);
    // Once approved, the same request under the same key still finds its draft, though the move
    // no longer follows the shipment's status.
    await r
      .post(`/shipment-status-drafts/${a.id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(200);
    const replay = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(replay).toMatchObject({ id: a.id, status: 'APPROVED' });
    await createDraft({ ...body, note: 'Another note' }).expect(409);
    expect(await t.prisma.shipmentStatusDraft.count({ where: { shipmentId: shipment.id } })).toBe(
      1,
    );
  });

  it('refuses another branch, a missing permission, a move NOLON refuses and bad fields', async () => {
    const shipment = await roadShipment();
    const before = await t.prisma.shipmentStatusDraft.count();
    await createDraft(statusRequest(shipment.id), tokens.opsJed).expect(404);
    // Sales sees shipments but cannot move them.
    await createDraft(statusRequest(shipment.id), tokens.sales).expect(403);
    // Not a move the state machine allows from CREATED.
    await createDraft(statusRequest(shipment.id, { status: 'ARRIVED_PORT' })).expect(409);
    // Closing, holding and cancelling stay a person's own actions.
    for (const status of ['CLOSED', 'ON_HOLD', 'CANCELLED']) {
      await createDraft(statusRequest(shipment.id, { status })).expect(400);
    }
    // Dated at the approval: the assistant cannot backdate a move.
    await createDraft(statusRequest(shipment.id, { occurredAt: '2026-01-01T00:00:00Z' })).expect(
      400,
    );
    await createDraft(statusRequest(shipment.id, { approved: true })).expect(400);
    await createDraft(statusRequest(shipment.id, { locationId: shipment.id })).expect(400);
    expect(await t.prisma.shipmentStatusDraft.count()).toBe(before);
  });

  it('cannot read or decide drafts, nor move the shipment itself; a person cannot create one', async () => {
    const shipment = await roadShipment();
    const draft = await statusDraft(statusRequest(shipment.id));
    await r.agentGet('/shipment-status-drafts', tokens.ops).expect(403);
    await r.agentGet(`/shipment-status-drafts/${draft.id}`, tokens.ops).expect(403);
    await r
      .agentPost(`/shipment-status-drafts/${draft.id}/approve`, tokens.ops, { version: 1 })
      .expect(403);
    await r
      .agentPost(`/shipment-status-drafts/${draft.id}/reject`, tokens.ops, {
        version: 1,
        reason: 'No',
      })
      .expect(403);
    await r
      .agentPost(`/shipments/${shipment.id}/status`, tokens.ops, { status: 'TRIP_SCHEDULED' })
      .expect(403);
    await r.post('/shipment-status-drafts', cookies.opsDxb, statusRequest(shipment.id)).expect(403);
    expect(await shipmentStatus(shipment.id)).toBe('CREATED');
  });
});

/** A road shipment on a planned trip driven by the Driver user (now TRIP_SCHEDULED). */
async function driversShipment(): Promise<ShipmentDto> {
  const suffix = String(randomInt(100_000, 999_999));
  const vehicle = (
    await r
      .post('/transport/vehicles', cookies.opsDxb, {
        branchId: dxb,
        plateNumber: `ZZ SD ${suffix}`,
        vehicleType: 'Flatbed trailer',
      })
      .expect(201)
  ).body as VehicleDto;
  const driver = (
    await r
      .post('/transport/drivers', cookies.opsDxb, {
        branchId: dxb,
        name: `ZZ Driver ${suffix}`,
        userId: driverUserId,
      })
      .expect(201)
  ).body as DriverDto;
  const shipment = await roadShipment();
  await r
    .post('/trips', cookies.opsDxb, {
      branchId: dxb,
      kind: 'OWN',
      originLocationId: portSudan,
      destinationLocationId: khartoum,
      vehicleId: vehicle.id,
      driverId: driver.id,
      shipmentIds: [shipment.id],
    })
    .expect(201);
  return shipment;
}

describe('shipment status drafts: a Driver', () => {
  it('reaches the drafts of their own trips only; another role lifts the limit', async () => {
    const own = await driversShipment();
    const ownDraft = await statusDraft(statusRequest(own.id, { status: 'ROAD_DEPARTED' }));
    const other = await roadShipment();
    const otherDraft = await statusDraft(statusRequest(other.id));
    const list = (await r.get('/shipment-status-drafts', cookies.driverDxb).expect(200))
      .body as ShipmentStatusDraftListItemDto[];
    expect(list.map((d) => d.id)).toContain(ownDraft.id);
    expect(list.map((d) => d.id)).not.toContain(otherDraft.id);
    await r.get(`/shipment-status-drafts/${otherDraft.id}`, cookies.driverDxb).expect(404);
    await r
      .post(`/shipment-status-drafts/${otherDraft.id}/reject`, cookies.driverDxb, {
        version: 1,
        reason: 'No',
      })
      .expect(404);
    await r
      .post(`/shipment-status-drafts/${otherDraft.id}/approve`, cookies.driverDxb, { version: 1 })
      .expect(404);
    const seen = (
      await r.get(`/shipment-status-drafts/${ownDraft.id}`, cookies.driverDxb).expect(200)
    ).body as ShipmentStatusDraftDto;
    expect(seen.shipmentNumber).toBe(own.number);
    const all = (await r.get('/shipment-status-drafts', cookies.driverOpsDxb).expect(200))
      .body as ShipmentStatusDraftListItemDto[];
    expect(all.map((d) => d.id)).toEqual(expect.arrayContaining([ownDraft.id, otherDraft.id]));
    expect(await shipmentStatus(other.id)).toBe('CREATED');
  });
});

describe('shipment status drafts: a person reviews', () => {
  it('shows drafts of their branches only, with the current and proposed status', async () => {
    const shipment = await roadShipment();
    const draft = await statusDraft(statusRequest(shipment.id));
    expect(draft).toMatchObject({
      status: 'DRAFT',
      shipmentNumber: shipment.number,
      currentStatus: 'CREATED',
      locationName: expect.any(String) as string,
      request: { status: 'TRIP_SCHEDULED', note: 'Truck booked for Sunday' },
      check: { ok: true },
      actions: { canDecide: true },
    });
    const list = (await r.get('/shipment-status-drafts?status=DRAFT', cookies.opsDxb).expect(200))
      .body as ShipmentStatusDraftListItemDto[];
    expect(list.find((d) => d.id === draft.id)).toMatchObject({
      status: 'DRAFT',
      targetStatus: 'TRIP_SCHEDULED',
    });
    const jed = (await r.get('/shipment-status-drafts', cookies.opsJed).expect(200))
      .body as ShipmentStatusDraftListItemDto[];
    expect(jed.some((d) => d.id === draft.id)).toBe(false);
    await r.get(`/shipment-status-drafts/${draft.id}`, cookies.opsJed).expect(404);
  });

  it('only someone who could make the move decides; another branch cannot', async () => {
    const shipment = await roadShipment();
    const draft = await statusDraft(statusRequest(shipment.id));
    for (const cookie of [cookies.salesDxb, cookies.whDxb]) {
      const seen = (await r.get(`/shipment-status-drafts/${draft.id}`, cookie).expect(200))
        .body as ShipmentStatusDraftDto;
      expect(seen.actions.canDecide).toBe(false);
      await r
        .post(`/shipment-status-drafts/${draft.id}/approve`, cookie, { version: 1 })
        .expect(403);
      await r
        .post(`/shipment-status-drafts/${draft.id}/reject`, cookie, { version: 1, reason: 'No' })
        .expect(403);
    }
    await r
      .post(`/shipment-status-drafts/${draft.id}/approve`, cookies.opsJed, { version: 1 })
      .expect(404);
    expect(await shipmentStatus(shipment.id)).toBe('CREATED');
  });

  it('the staff of a stage decide the move of their stage', async () => {
    const shipment = await roadShipment();
    const draft = await statusDraft(
      statusRequest(shipment.id, { status: 'RECEIVED_ORIGIN_WAREHOUSE' }),
    );
    const seen = (await r.get(`/shipment-status-drafts/${draft.id}`, cookies.whDxb).expect(200))
      .body as ShipmentStatusDraftDto;
    expect(seen.actions.canDecide).toBe(true);
    await r
      .post(`/shipment-status-drafts/${draft.id}/approve`, cookies.whDxb, { version: 1 })
      .expect(200);
    expect(await shipmentStatus(shipment.id)).toBe('RECEIVED_ORIGIN_WAREHOUSE');
  });

  it('approves into an ordinary status change through the state machine, once', async () => {
    const shipment = await roadShipment();
    const draft = await statusDraft(statusRequest(shipment.id));
    const eventsBefore = await t.prisma.shipmentEvent.count({ where: { shipmentId: shipment.id } });
    const approved = (
      await r
        .post(`/shipment-status-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 })
        .expect(200)
    ).body as ShipmentStatusDraftDto;
    expect(approved).toMatchObject({ status: 'APPROVED', check: null });
    expect(await shipmentStatus(shipment.id)).toBe('TRIP_SCHEDULED');
    // Approving again returns it as it is, and records no second move.
    await r
      .post(`/shipment-status-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(200);
    const events = await t.prisma.shipmentEvent.findMany({
      where: { shipmentId: shipment.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.length).toBe(eventsBefore + 1);
    expect(events.at(-1)).toMatchObject({
      status: 'TRIP_SCHEDULED',
      locationId: portSudan,
      note: 'Truck booked for Sunday',
    });
  });

  it('refuses a move the shipment has outgrown, checked again on approval, and leaves the draft open', async () => {
    const shipment = await roadShipment();
    const staleBody = statusRequest(shipment.id);
    const draft = await statusDraft(staleBody);
    // Staff scheduled the trip directly; the same move no longer follows.
    await r
      .post(`/shipments/${shipment.id}/status`, cookies.opsDxb, { status: 'TRIP_SCHEDULED' })
      .expect(200);
    // The assistant's retry under the same key still finds the open draft.
    const replay = (await createDraft(staleBody).expect(201)).body as EntryDraftSummaryDto;
    expect(replay.id).toBe(draft.id);
    const stale = (await r.get(`/shipment-status-drafts/${draft.id}`, cookies.opsDxb).expect(200))
      .body as ShipmentStatusDraftDto;
    expect(stale.check).toMatchObject({ ok: false });
    await r
      .post(`/shipment-status-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(409);
    expect(await shipmentStatus(shipment.id)).toBe('TRIP_SCHEDULED');
    expect(
      (await t.prisma.shipmentStatusDraft.findUniqueOrThrow({ where: { id: draft.id } })).state,
    ).toBe('DRAFT');
  });

  it('two concurrent approvals of drafts for the same move apply it once', async () => {
    const shipment = await roadShipment();
    const first = await statusDraft(statusRequest(shipment.id));
    const second = await statusDraft(statusRequest(shipment.id));
    const results = await Promise.all([
      r.post(`/shipment-status-drafts/${first.id}/approve`, cookies.opsDxb, { version: 1 }),
      r.post(`/shipment-status-drafts/${second.id}/approve`, cookies.opsDxb, { version: 1 }),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(
      await t.prisma.shipmentEvent.count({
        where: { shipmentId: shipment.id, status: 'TRIP_SCHEDULED' },
      }),
    ).toBe(1);
  });

  it('rejects with a reason; the database keeps decided drafts as they are', async () => {
    const shipment = await roadShipment();
    const draft = await statusDraft(statusRequest(shipment.id));
    const rejected = (
      await r
        .post(`/shipment-status-drafts/${draft.id}/reject`, cookies.opsDxb, {
          version: 1,
          reason: 'Pickup is next week',
        })
        .expect(200)
    ).body as ShipmentStatusDraftDto;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'Pickup is next week' });
    await r
      .post(`/shipment-status-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 2 })
      .expect(409);
    expect(await shipmentStatus(shipment.id)).toBe('CREATED');
    await expect(
      t.prisma.shipmentStatusDraft.update({ where: { id: draft.id }, data: { note: 'Changed' } }),
    ).rejects.toThrow(/decided/);
  });

  it('the database refuses a draft that closes, holds or cancels a shipment', async () => {
    const shipment = await roadShipment();
    const draft = await statusDraft(statusRequest(shipment.id));
    await expect(
      t.prisma.shipmentStatusDraft.update({ where: { id: draft.id }, data: { status: 'CLOSED' } }),
    ).rejects.toThrow(/status_check/);
  });
});

describe('shipment status drafts: replacing a draft', () => {
  it('a new draft replaces the one the person asked to change', async () => {
    const shipment = await roadShipment();
    const old = await statusDraft(statusRequest(shipment.id));
    const created = (
      await createDraft({
        ...statusRequest(shipment.id, { status: 'RECEIVED_ORIGIN_WAREHOUSE', note: null }),
        replacesDraftId: old.id,
      }).expect(201)
    ).body as EntryDraftSummaryDto;
    const replaced = (await r.get(`/shipment-status-drafts/${old.id}`, cookies.opsDxb).expect(200))
      .body as ShipmentStatusDraftDto;
    expect(replaced.status).toBe('REJECTED');
    const newer = (await r.get(`/shipment-status-drafts/${created.id}`, cookies.opsDxb).expect(200))
      .body as ShipmentStatusDraftDto;
    expect(newer).toMatchObject({
      replacesDraftId: old.id,
      request: { status: 'RECEIVED_ORIGIN_WAREHOUSE' },
    });
    // Another branch's assistant cannot replace it.
    const other = await statusDraft(statusRequest(shipment.id));
    await createDraft(
      { ...statusRequest(shipment.id), replacesDraftId: other.id },
      tokens.opsJed,
    ).expect(404);
  });

  /** Waits until `count` requests wait on the shipment lock, or fails after about 5 seconds. */
  async function waiters(count: number): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const rows = await t.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE NOT granted AND locktype IN ('transactionid', 'tuple', 'relation')`;
      if ((rows[0]?.n ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Expected ${count} lock waiters`);
  }

  it('replacing a draft while it is approved: one wins, the other gets 409, no deadlock', async () => {
    const shipment = await roadShipment();
    const draft = await statusDraft(statusRequest(shipment.id));
    // Hold the shipment so the approval queues first and the replacement after it.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = t.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "id" = ${shipment.id}::uuid FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    try {
      await isLocked;
      const approving = r
        .post(`/shipment-status-drafts/${draft.id}/approve`, cookies.opsDxb, { version: 1 })
        .then((x) => x);
      await waiters(1);
      const replacing = createDraft({
        ...statusRequest(shipment.id, { status: 'RECEIVED_ORIGIN_WAREHOUSE' }),
        replacesDraftId: draft.id,
      }).then((x) => x);
      await waiters(2);
      release();
      await holder;
      const [approved, replaced] = await Promise.all([approving, replacing]);
      expect([approved.status, replaced.status]).toEqual([200, 409]);
    } finally {
      release();
      await holder;
    }
    expect(await shipmentStatus(shipment.id)).toBe('TRIP_SCHEDULED');
    expect(await t.prisma.shipmentStatusDraft.count({ where: { replacesDraftId: draft.id } })).toBe(
      0,
    );
  });
});

describe("shipment status drafts: the staff member's words", () => {
  it('shows the words next to the values and approves only once each is ticked', async () => {
    const shipment = await roadShipment();
    const evidence = [
      { field: 'shipmentId', quote: shipment.number },
      { field: 'locationId', quote: 'بورتسودان' },
      // Words that do not give the value: code cannot tell, the person can.
      { field: 'status', quote: 'وصلت الميناء' },
    ];
    const draft = await statusDraft(statusRequest(shipment.id, { evidence }));
    expect(draft.evidence).toEqual(evidence);
    const approve = (confirmed?: string[]) =>
      r.post(`/shipment-status-drafts/${draft.id}/approve`, cookies.opsDxb, {
        version: 1,
        ...(confirmed ? { confirmed } : {}),
      });
    await approve().expect(400);
    await approve(['shipmentId', 'locationId']).expect(400);
    expect(await shipmentStatus(shipment.id)).toBe('CREATED');
    // The person reads "arrived at the port" against TRIP_SCHEDULED and rejects it instead.
    await r
      .post(`/shipment-status-drafts/${draft.id}/reject`, cookies.opsDxb, {
        version: 1,
        reason: 'The words say arrived at the port',
      })
      .expect(200);
    const ticked = await statusDraft(
      statusRequest(shipment.id, { evidence: evidence.slice(0, 2) }),
    );
    await r
      .post(`/shipment-status-drafts/${ticked.id}/approve`, cookies.opsDxb, {
        version: 1,
        confirmed: ['locationId', 'shipmentId'],
      })
      .expect(200);
    expect(await shipmentStatus(shipment.id)).toBe('TRIP_SCHEDULED');
  });

  it('refuses words for a field it does not bind', async () => {
    const shipment = await roadShipment();
    await createDraft(
      statusRequest(shipment.id, { evidence: [{ field: 'note', quote: 'x' }] }),
    ).expect(400);
  });
});

// Drafts saved with missing values (no-required-fields plan, 3.2 and 3.3): a status draft may name
// no shipment yet (it then names its branch) and no status; a person fills them in (PATCH), and
// approving is refused (422) until nothing is missing, moving no shipment.
describe('shipment status drafts saved with missing values', () => {
  const read = async (id: string, cookie = cookies.opsDxb) =>
    (await r.get(`/shipment-status-drafts/${id}`, cookie).expect(200))
      .body as ShipmentStatusDraftDto;

  it('saves a draft naming only its branch, and one naming only its shipment', async () => {
    const empty = (await createDraft({ idempotencyKey: draftKey(), branchId: dxb }).expect(201))
      .body as EntryDraftSummaryDto;
    expect(empty.missingFields).toEqual(['shipmentId', 'status']);
    expect(await read(empty.id)).toMatchObject({
      shipmentId: null,
      shipmentNumber: null,
      currentStatus: null,
      check: null,
      actions: { canEdit: true, canDecide: true },
      request: { status: null },
    });
    const list = (await r.get('/shipment-status-drafts?status=DRAFT', cookies.opsDxb).expect(200))
      .body as ShipmentStatusDraftListItemDto[];
    expect(list.find((d) => d.id === empty.id)).toMatchObject({ targetStatus: null });
    await r.get(`/shipment-status-drafts/${empty.id}`, cookies.opsJed).expect(404);
    // A driver sees only the shipments of their own trips: none of a draft without one.
    await r.get(`/shipment-status-drafts/${empty.id}`, cookies.driverDxb).expect(404);

    const shipment = await roadShipment();
    const partial = (
      await createDraft({ idempotencyKey: draftKey(), shipmentId: shipment.id }).expect(201)
    ).body as EntryDraftSummaryDto;
    expect(partial.missingFields).toEqual(['status']);
    expect(await read(partial.id)).toMatchObject({
      shipmentNumber: shipment.number,
      currentStatus: 'CREATED',
      check: null,
    });
  });

  it('refuses a draft without a branch, of another branch, or a status it cannot set', async () => {
    const before = await t.prisma.shipmentStatusDraft.count();
    const jed = await branchId(t.prisma, 'JED');
    const res = await createDraft({ idempotencyKey: draftKey(), note: 'x' }).expect(400);
    expect((res.body as { code?: string }).code).toBe('BRANCH_REQUIRED');
    await createDraft({ idempotencyKey: draftKey(), branchId: jed }).expect(403);
    await createDraft({ idempotencyKey: draftKey(), branchId: dxb, status: 'FLYING' }).expect(400);
    expect(await t.prisma.shipmentStatusDraft.count()).toBe(before);
  });

  it('refuses the approval while values are missing, then approves once filled in', async () => {
    const shipment = await roadShipment();
    const { id } = (
      await createDraft({ idempotencyKey: draftKey(), shipmentId: shipment.id }).expect(201)
    ).body as EntryDraftSummaryDto;
    expectGateRefusal(
      await r.post(`/shipment-status-drafts/${id}/approve`, cookies.opsDxb, { version: 1 }),
      ['status'],
    );
    expect(await shipmentStatus(shipment.id)).toBe('CREATED');

    const edit = (cookie: string, body: object) =>
      r.patch(`/shipment-status-drafts/${id}`, cookie, body);
    await edit(cookies.opsJed, { version: 1, status: 'TRIP_SCHEDULED' }).expect(404);
    await edit(cookies.salesDxb, { version: 1, status: 'TRIP_SCHEDULED' }).expect(403);
    await r
      .agentPatch(`/shipment-status-drafts/${id}`, tokens.ops, { version: 1, note: 'x' })
      .expect(403);
    await edit(cookies.opsDxb, { version: 2, status: 'TRIP_SCHEDULED' }).expect(409);
    await edit(cookies.opsDxb, { version: 1, status: 'FLYING' }).expect(400);
    // Once named, the shipment stays.
    const other = await roadShipment();
    await edit(cookies.opsDxb, { version: 1, shipmentId: other.id }).expect(400);
    const filled = (
      await edit(cookies.opsDxb, { version: 1, status: 'TRIP_SCHEDULED' }).expect(200)
    ).body as ShipmentStatusDraftDto;
    expect(filled).toMatchObject({ version: 2, missingFields: [], check: { ok: true } });
    await r
      .post(`/shipment-status-drafts/${id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(409);
    const approved = (
      await r
        .post(`/shipment-status-drafts/${id}/approve`, cookies.opsDxb, { version: 2 })
        .expect(200)
    ).body as ShipmentStatusDraftDto;
    expect(approved.status).toBe('APPROVED');
    await r
      .post(`/shipment-status-drafts/${id}/approve`, cookies.opsDxb, { version: 2 })
      .expect(200);
    expect(await shipmentStatus(shipment.id)).toBe('TRIP_SCHEDULED');
  });
});

// A shipment shared with a branch is visible there, but a draft is filed in the shipment's own
// branch: one the sharing branch's staff do not hold. Neither a save, its pre-check nor an edit
// may file a draft there (403); nothing is written.
describe('shipment status drafts for a shipment shared with another branch', () => {
  it('refuses to file a draft in the shipment branch the user does not hold', async () => {
    const jed = await branchId(t.prisma, 'JED');
    const shipment = await roadShipment();
    await t.prisma.shipmentBranch.create({ data: { shipmentId: shipment.id, branchId: jed } });
    // The JED staff see the shipment...
    await r.get(`/shipments/${shipment.id}`, cookies.opsJed).expect(200);
    const before = await t.prisma.shipmentStatusDraft.count();
    // ...but cannot file a draft of it in DXB, with or without the status, or naming their branch.
    await createDraft(
      { idempotencyKey: draftKey(), shipmentId: shipment.id },
      tokens.opsJed,
    ).expect(403);
    await createDraft(statusRequest(shipment.id), tokens.opsJed).expect(403);
    const mismatch = await createDraft(
      { idempotencyKey: draftKey(), shipmentId: shipment.id, branchId: jed },
      tokens.opsJed,
    ).expect(400);
    expect((mismatch.body as { code?: string }).code).toBe('BRANCH_MISMATCH');
    const check = (
      await r
        .agentPost('/shipment-status-drafts/check', tokens.opsJed, {
          idempotencyKey: draftKey(),
          shipmentId: shipment.id,
        })
        .expect(200)
    ).body as DraftPreCheckDto;
    expect(check.ok).toBe(false);
    expect(await t.prisma.shipmentStatusDraft.count()).toBe(before);

    // A JED draft without a shipment cannot be moved onto it by an edit either: the draft stays in
    // its branch, which is not the shipment's.
    const { id } = (
      await createDraft({ idempotencyKey: draftKey(), branchId: jed }, tokens.opsJed).expect(201)
    ).body as EntryDraftSummaryDto;
    await r
      .patch(`/shipment-status-drafts/${id}`, cookies.opsJed, {
        version: 1,
        shipmentId: shipment.id,
      })
      .expect(400);
    expect(await t.prisma.shipmentStatusDraft.findUniqueOrThrow({ where: { id } })).toMatchObject({
      version: 1,
      shipmentId: null,
      branchId: jed,
    });
    // The shipment's own branch still files it; the JED staff, who see it through the shipment,
    // cannot edit it.
    const own = (
      await createDraft({ idempotencyKey: draftKey(), shipmentId: shipment.id }).expect(201)
    ).body as EntryDraftSummaryDto;
    const shared = await r.patch(`/shipment-status-drafts/${own.id}`, cookies.opsJed, {
      version: 1,
      status: 'TRIP_SCHEDULED',
    });
    expect(shared.status).toBe(403);
    expect(
      await t.prisma.shipmentStatusDraft.findUniqueOrThrow({ where: { id: own.id } }),
    ).toMatchObject({ version: 1, status: null });
  });
});
