import { randomUUID } from 'node:crypto';
import type {
  AgentClientCreatedDto,
  AssistantDraftDto,
  BookingDraftDto,
  BookingDto,
  ConsolidationDto,
  CustomerDto,
  EntryDraftSummaryDto,
  NewCustomerBookingDraftDto,
  NewCustomerBookingDraftSummaryDto,
} from '@nolon/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEDGER_PREFIX,
  type TestApp,
  branchId,
  createTestApp,
  createUser,
  signIn,
} from './auth-test-app.js';
import {
  AGENT_PREFIX,
  draftKey,
  registerClient,
  requests,
  tokenFor,
} from './agent-drafts-helpers.js';
import { uniquePhone } from './test-data.js';

// Booking drafts that name an open LCL container (owner, 2026-10-13: staff ask the assistant to
// ship on a given open container; any branch books into it, only its branch changes it). Approving
// one books into the container as its page does: recorded, confirmed, its shipment put in it, in
// one transaction. Confirmed bookings make shipments, which are never deleted, so the people here
// keep the ledger prefix (outside the usual cleanup), as in the container tests.

let t: TestApp;
let r: ReturnType<typeof requests>;
let client: AgentClientCreatedDto;
let dxb: string;
let jebelAli: string;
let portSudan: string;
let khartoum: string;
let jedCustomer: CustomerDto;

const cookies = { admin: '', opsDxb: '', opsJed: '', salesJed: '', adminJed: '' };
const tokens = { opsJed: '', salesJed: '', adminJed: '' };

const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

/** A DXB container from Jebel Ali to Port Sudan, open, empty. */
async function openContainer(): Promise<ConsolidationDto> {
  return (
    await r
      .post('/consolidations', cookies.opsDxb, {
        branchId: dxb,
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        containerTypeCode: '20GP',
        vesselName: 'Maersk Emaa',
        // No ETD: the list filter tests count containers by their ETD.
        shipmentIds: [],
      })
      .expect(201)
  ).body as ConsolidationDto;
}

function lclBooking(consolidationId: string | undefined, extra: object = {}) {
  return {
    idempotencyKey: draftKey(),
    customerId: jedCustomer.id,
    originLocationId: jebelAli,
    destinationLocationId: portSudan,
    mode: 'SEA',
    loadType: 'LCL',
    cargoType: 'BARREL',
    services: ['MAIN_FREIGHT', 'LAST_MILE'],
    items: [{ cargoType: 'BARREL', quantity: 1, weightKg: '100', volumeCbm: '0.3' }],
    ...(consolidationId === undefined ? {} : { consolidationId }),
    ...extra,
  };
}

const createDraft = (body: object, token = tokens.opsJed) =>
  r.agentPost('/booking-drafts', token, body);
const readDraft = async (id: string, cookie = cookies.opsJed) =>
  (await r.get(`/booking-drafts/${id}`, cookie).expect(200)).body as BookingDraftDto;
const bookingsOfCustomer = () => t.prisma.booking.count({ where: { customerId: jedCustomer.id } });

beforeAll(async () => {
  t = await createTestApp();
  r = requests(t);
  dxb = await branchId(t.prisma, 'DXB');
  const jed = await branchId(t.prisma, 'JED');
  const loc = async (c: string) =>
    (await t.prisma.location.findUniqueOrThrow({ where: { code: c } })).id;
  jebelAli = await loc('AEJEA');
  portSudan = await loc('SDPZU');
  khartoum = await loc('SDKRT');
  const people = {
    admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], AGENT_PREFIX),
    opsDxb: await createUser(t.prisma, ['OPERATIONS'], ['DXB'], LEDGER_PREFIX),
    opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
    salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
    adminJed: await createUser(t.prisma, ['ADMINISTRATOR'], ['JED'], LEDGER_PREFIX),
  };
  for (const key of Object.keys(people) as (keyof typeof people)[]) {
    cookies[key] = await signIn(t, people[key].email);
  }
  client = await registerClient(t, cookies.admin, `Container drafts ${randomUUID().slice(0, 6)}`);
  const agents = {
    opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], AGENT_PREFIX),
    salesJed: await createUser(t.prisma, ['SALES'], ['JED'], AGENT_PREFIX),
    adminJed: await createUser(t.prisma, ['ADMINISTRATOR'], ['JED'], AGENT_PREFIX),
  };
  for (const key of Object.keys(agents) as (keyof typeof agents)[]) {
    tokens[key] = await tokenFor(t, await signIn(t, agents[key].email), client);
  }
  jedCustomer = (
    await r
      .post('/customers', cookies.salesJed, {
        branchId: jed,
        kind: 'INDIVIDUAL',
        name: `Kamal Ali ${randomUUID().slice(0, 6)}`,
        phone: uniquePhone(),
      })
      .expect(201)
  ).body as CustomerDto;
});

afterAll(async () => {
  await t.close();
});

describe('booking drafts into an open container', () => {
  it("books another branch's customer into the container on approval, confirmed and in it", async () => {
    const container = await openContainer();
    const body = lclBooking(container.id);
    const summary = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    // Nothing is booked until a person approves.
    expect(await bookingsOfCustomer()).toBe(0);

    const draft = await readDraft(summary.id);
    expect(draft.request).toMatchObject({ consolidationId: container.id });
    expect(draft.container).toMatchObject({
      id: container.id,
      number: container.number,
      status: 'OPEN',
      containerTypeCode: '20GP',
      etd: null,
    });
    expect(draft.check).toEqual({ ok: true, total: null, currency: null });

    // The assistant's card names the container, never a bare id.
    const card = (
      await r.agentGet(`/booking-drafts/${summary.id}/assistant`, tokens.opsJed).expect(200)
    ).body as AssistantDraftDto<BookingDraftDto>;
    expect(card.names[container.id]).toContain(container.number);

    // A repeat returns the same draft; the key with the container left out is another request.
    const again = (await createDraft(body).expect(201)).body as EntryDraftSummaryDto;
    expect(again.id).toBe(summary.id);
    await createDraft({ ...body, consolidationId: undefined }).expect(409);

    const approved = (
      await r
        .post(`/booking-drafts/${summary.id}/approve`, cookies.opsJed, { version: 1 })
        .expect(200)
    ).body as BookingDraftDto;
    expect(approved.status).toBe('APPROVED');
    const booking = (await r.get(`/bookings/${approved.bookingId}`, cookies.opsJed).expect(200))
      .body as BookingDto;
    expect(booking).toMatchObject({
      status: 'CONFIRMED',
      mode: 'SEA',
      loadType: 'LCL',
      customerId: jedCustomer.id,
      originLocationId: jebelAli,
    });
    expect(booking.shipmentId).not.toBeNull();
    // The shipment is JED's, in DXB's container, and shared with DXB, which loads it.
    const link = await t.prisma.consolidationShipment.findFirstOrThrow({
      where: { shipmentId: booking.shipmentId ?? '' },
    });
    expect(link.consolidationId).toBe(container.id);
    const shared = await t.prisma.shipmentBranch.findMany({
      where: { shipmentId: booking.shipmentId ?? '' },
    });
    expect(shared.map((s) => s.branchId)).toEqual([dxb]);
    // Approving again books nothing more.
    await r
      .post(`/booking-drafts/${summary.id}/approve`, cookies.opsJed, { version: 1 })
      .expect(200);
    expect(await bookingsOfCustomer()).toBe(1);
  });

  it('refuses a booking that does not fit the container, naming why, and stores nothing', async () => {
    const container = await openContainer();
    const before = await t.prisma.bookingDraft.count({ where: { consolidationId: container.id } });
    const refused = async (body: object, status: number, token = tokens.opsJed) =>
      code(await createDraft(body, token).expect(status));

    expect(await refused(lclBooking(container.id, { loadType: 'FCL' }), 400)).toBe(
      'CONTAINER_BOOKING_NOT_LCL_SEA',
    );
    expect(await refused(lclBooking(container.id, { mode: 'ROAD', loadType: null }), 400)).toBe(
      'CONTAINER_BOOKING_NOT_LCL_SEA',
    );
    expect(
      await refused(
        lclBooking(container.id, { originLocationId: khartoum, destinationLocationId: portSudan }),
        400,
      ),
    ).toBe('CONTAINER_BOOKING_OTHER_PORT');
    expect(await refused(lclBooking(container.id, { services: ['LAST_MILE'] }), 400)).toBe(
      'CONTAINER_BOOKING_NO_MAIN_FREIGHT',
    );
    // Sales may book but not into containers (annex A: no consolidation rights).
    await createDraft(lclBooking(container.id), tokens.salesJed).expect(403);
    // A container that does not exist, and a bad id.
    await createDraft(lclBooking(randomUUID())).expect(404);
    await createDraft(lclBooking('not-a-uuid')).expect(400);
    // A booking from a quotation takes its route from it: it names no container here.
    await createDraft({
      idempotencyKey: draftKey(),
      quotationId: randomUUID(),
      consolidationId: container.id,
    }).expect(400);
    expect(await t.prisma.bookingDraft.count({ where: { consolidationId: container.id } })).toBe(
      before,
    );
  });

  it('refuses the approval once the container is no longer open, creating nothing', async () => {
    const container = await openContainer();
    const summary = (await createDraft(lclBooking(container.id)).expect(201))
      .body as EntryDraftSummaryDto;
    const before = await bookingsOfCustomer();
    // Only its branch cancels the container.
    await r
      .post(`/consolidations/${container.id}/cancel`, cookies.opsDxb, { reason: 'Vessel missed' })
      .expect(200);

    const draft = await readDraft(summary.id);
    expect(draft.check).toMatchObject({ ok: false });
    expect(draft.check?.ok === false && draft.check.message).toMatch(/no longer open/);
    const res = await r
      .post(`/booking-drafts/${summary.id}/approve`, cookies.opsJed, { version: 1 })
      .expect(409);
    expect(code(res)).toBe('CONTAINER_NOT_OPEN');
    expect((await readDraft(summary.id)).status).toBe('DRAFT');
    expect(await bookingsOfCustomer()).toBe(before);
  });

  it('refuses an approver who may not book into containers, creating nothing', async () => {
    const container = await openContainer();
    const summary = (await createDraft(lclBooking(container.id)).expect(201))
      .body as EntryDraftSummaryDto;
    const before = await bookingsOfCustomer();
    // Sales of the customer's branch sees the draft but may not book into a container.
    expect((await readDraft(summary.id, cookies.salesJed)).check).toMatchObject({ ok: false });
    await r
      .post(`/booking-drafts/${summary.id}/approve`, cookies.salesJed, { version: 1 })
      .expect(403);
    // The container's branch does not see a JED customer's draft at all.
    await r.get(`/booking-drafts/${summary.id}`, cookies.opsDxb).expect(404);
    await r
      .post(`/booking-drafts/${summary.id}/approve`, cookies.opsDxb, { version: 1 })
      .expect(404);
    expect(await bookingsOfCustomer()).toBe(before);
    expect((await readDraft(summary.id)).status).toBe('DRAFT');
  });
});

describe('bookings for a new customer into an open container', () => {
  const API = '/new-customer-booking-drafts';

  it('books the approved customer into the container, with the container among the ticked words', async () => {
    const container = await openContainer();
    const jed = await branchId(t.prisma, 'JED');
    const evidence = [
      { field: 'name', quote: 'كمال علي' },
      { field: 'consolidationId', quote: `على الحاوية ${container.number}` },
      { field: 'items[0].quantity', quote: 'برميل واحد' },
    ];
    const body = {
      idempotencyKey: draftKey(),
      branchId: jed,
      customer: { kind: 'INDIVIDUAL', name: 'كمال علي', phone: uniquePhone() },
      booking: {
        originLocationId: jebelAli,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'LCL',
        cargoType: 'BARREL',
        services: ['MAIN_FREIGHT'],
        consolidationId: container.id,
        items: [{ cargoType: 'BARREL', quantity: 1, weightKg: '100' }],
      },
      evidence,
    };
    // Operations may not add customers and Sales may not book into containers (annex A): only
    // a role with both rights proposes this one (here the administrator).
    await r.agentPost(API, tokens.opsJed, body).expect(403);
    await r.agentPost(API, tokens.salesJed, { ...body, idempotencyKey: draftKey() }).expect(403);
    await r
      .agentPost(API, tokens.adminJed, {
        ...body,
        idempotencyKey: draftKey(),
        booking: { ...body.booking, loadType: 'FCL' },
      })
      .expect(400);
    const summary = (await r.agentPost(API, tokens.adminJed, body).expect(201))
      .body as NewCustomerBookingDraftSummaryDto;
    await r
      .post(`/customer-drafts/${summary.customerDraftId}/approve`, cookies.adminJed, {
        version: 1,
        confirmed: ['name'],
      })
      .expect(200);
    const draft = (await r.get(`${API}/${summary.id}`, cookies.adminJed).expect(200))
      .body as NewCustomerBookingDraftDto;
    expect(draft.request.consolidationId).toBe(container.id);
    expect(draft.container?.number).toBe(container.number);
    expect(draft.check).toMatchObject({ ok: true });

    // The container is one of the values the person ticks.
    await r
      .post(`${API}/${summary.id}/approve`, cookies.adminJed, {
        version: 1,
        confirmed: ['items[0].quantity'],
      })
      .expect(400);
    const approved = (
      await r
        .post(`${API}/${summary.id}/approve`, cookies.adminJed, {
          version: 1,
          confirmed: ['consolidationId', 'items[0].quantity'],
        })
        .expect(200)
    ).body as NewCustomerBookingDraftDto;
    const booking = (await r.get(`/bookings/${approved.bookingId}`, cookies.adminJed).expect(200))
      .body as BookingDto;
    expect(booking.status).toBe('CONFIRMED');
    const link = await t.prisma.consolidationShipment.findFirstOrThrow({
      where: { shipmentId: booking.shipmentId ?? '' },
    });
    expect(link.consolidationId).toBe(container.id);
  });
});
