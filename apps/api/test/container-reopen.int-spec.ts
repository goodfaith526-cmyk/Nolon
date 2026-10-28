import { randomInt, randomUUID } from 'node:crypto';
import type {
  AuditLogDto,
  BookingDto,
  ConsolidationDto,
  CustomerDto,
  ShipmentDto,
  SupplierBillDto,
  SupplierDto,
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
 * B3-5 (docs/plans/05-correction-contracts.md, sections 0 and 5): opening a container closed by
 * mistake again, before anything was charged to it. Supplier bills post entries that are never
 * deleted, so these are LEDGER users and every date is in a random past year.
 */
describe('reopening a closed container (B3-5)', () => {
  let t: TestApp;
  let jed: string;
  let pts: string;
  let jeddahPort: string;
  let portSudan: string;
  let customer: CustomerDto;
  let supplier: SupplierDto;
  let opsJedId: string;
  const year = randomInt(1901, 2000);
  const d = (monthDay: string) => `${year}-${monthDay}`;
  const at = (monthDay: string) => `${year}-${monthDay}T08:00:00+03:00`;
  const cookies = {
    admin: '',
    opsJed: '',
    salesJed: '',
    financeJed: '',
    opsPts: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const params = (res: { body: unknown }) => (res.body as { params?: object }).params;

  const container = async (id: string, cookie = cookies.opsJed) =>
    (await get(`/consolidations/${id}`, cookie).expect(200)).body as ConsolidationDto;
  const shipment = async (id: string) =>
    (await get(`/shipments/${id}`, cookies.opsJed).expect(200)).body as ShipmentDto;

  /** A valid ISO 6346 container number (owner code ZQR, U). */
  function containerNumber(): string {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const value = (ch: string) => {
      const n = letters.indexOf(ch);
      if (n < 0) return Number(ch);
      const v = 10 + n;
      return v + Math.floor((v - 1) / 10);
    };
    const body = `ZQRU${randomInt(100000, 999999)}`;
    const check = ([...body].reduce((sum, ch, i) => sum + value(ch) * 2 ** i, 0) % 11) % 10;
    return `${body}${check}`;
  }

  /** A confirmed Jeddah → Port Sudan LCL shipment of `volumeCbm`; its id. */
  async function lclShipment(volumeCbm: string): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesJed, {
        customerId: customer.id,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'LCL',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 2, weightKg: '500', volumeCbm }],
      }).expect(201)
    ).body as BookingDto;
    const confirmed = (await post(`/bookings/${booking.id}/confirm`, cookies.salesJed).expect(200))
      .body as BookingDto;
    if (!confirmed.shipmentId) throw new Error('No shipment');
    await t.prisma.shipmentEvent.updateMany({
      where: { shipmentId: confirmed.shipmentId },
      data: { occurredAt: new Date(at('01-02')) },
    });
    return confirmed.shipmentId;
  }

  /** A container of `shipmentIds`, closed on `day`. */
  async function closedContainer(shipmentIds: string[], day = '03-01'): Promise<ConsolidationDto> {
    const created = (
      await post('/consolidations', cookies.opsJed, {
        branchId: jed,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        containerTypeCode: '40HC',
        containerNumber: containerNumber(),
        etd: d('03-05'),
        eta: d('03-09'),
        shipmentIds,
      }).expect(201)
    ).body as ConsolidationDto;
    await close(created.id, day);
    return container(created.id);
  }
  /** Closes on `day`; without one, now (after a reopening, whose REVERT events are dated now). */
  const close = (id: string, day?: string) =>
    post(`/consolidations/${id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      ...(day ? { occurredAt: at(day) } : {}),
    }).expect(200);

  /** A reopening request on the revision the container shows now, with a new request id. */
  const request = async (id: string, reason = 'Closed by mistake') => ({
    requestId: randomUUID(),
    expectedRevision: (await container(id)).reopenRevision,
    expectedStatus: 'CLOSED',
    reason,
  });
  const reopen = (id: string, body: object, cookie = cookies.opsJed) =>
    post(`/consolidations/${id}/reopen`, cookie, body);

  async function approvedBill(consolidationId: string, billDate: string) {
    const draft = (
      await post('/supplier-bills', cookies.financeJed, {
        requestId: randomUUID(),
        supplierId: supplier.id,
        branchId: jed,
        currency: 'USD',
        billDate,
        dueDate: billDate,
        lines: [
          {
            kind: 'CONSOLIDATION',
            consolidationId,
            chargeTypeCode: 'FREIGHT',
            description: 'Ocean freight, whole container',
            amount: '1000',
          },
        ],
      }).expect(201)
    ).body as SupplierBillDto;
    return draft;
  }
  const approve = (billId: string) => post(`/supplier-bills/${billId}/approve`, cookies.financeJed);

  beforeAll(async () => {
    t = await createTestApp();
    jed = await branchId(t.prisma, 'JED');
    pts = await branchId(t.prisma, 'PTS');
    const loc = async (c: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code: c } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
      financeJed: await createUser(t.prisma, ['FINANCE'], ['JED'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
    };
    opsJedId = users.opsJed.id;
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    customer = (
      await post('/customers', cookies.salesJed, {
        branchId: jed,
        kind: 'COMPANY',
        name: `Reopen ${year} ${randomUUID().slice(0, 6)}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    supplier = (
      await post('/suppliers', cookies.financeJed, {
        name: `Reopen Line ${randomUUID().slice(0, 6)}`,
        paymentTermsDays: 30,
      }).expect(201)
    ).body as SupplierDto;
  });

  afterAll(async () => {
    await t.close();
  });

  it('opens it again: shipments back before the close, basis cleared; a new close freezes again', async () => {
    const ids = [await lclShipment('2'), await lclShipment('3')];
    const placeBefore = (await shipment(ids[0]!)).currentLocationId;
    const closed = await closedContainer(ids);
    expect(closed.status).toBe('CLOSED');
    expect(closed.reopenRevision).toBe(0);
    expect(closed.actions.canReopen).toBe(true);
    expect(closed.shipments.map((s) => s.basisValue).sort()).toEqual(['2', '3']);
    expect((await shipment(ids[0]!)).status).toBe('CONSOLIDATED');

    const body = await request(closed.id);
    const opened = (await reopen(closed.id, body).expect(200)).body as ConsolidationDto;
    expect(opened).toMatchObject({ status: 'OPEN', closedAt: null, reopenRevision: 1 });
    expect(opened.actions.canReopen).toBe(false);
    expect(opened.actions.canEditShipments).toBe(true);
    expect(opened.shipments.map((s) => s.basisValue)).toEqual([null, null]);
    expect(opened.reopenings).toEqual([
      expect.objectContaining({ revision: 1, reason: 'Closed by mistake', shipmentCount: 2 }),
    ]);
    for (const id of ids) {
      const s = await shipment(id);
      expect(s.status).toBe('CREATED');
      expect(s.currentLocationId).toBe(placeBefore);
    }
    const events = await t.prisma.shipmentEvent.findMany({
      where: { shipmentId: ids[0], kind: 'REVERT' },
    });
    expect(events).toEqual([
      expect.objectContaining({
        status: 'CREATED',
        reason: 'Closed by mistake',
        note: closed.number,
      }),
    ]);
    const stored = await t.prisma.consolidationReopening.findFirstOrThrow({
      where: { consolidationId: closed.id },
    });
    expect(stored.closedAt.toISOString()).toBe(new Date(at('03-01')).toISOString());
    expect(stored.basis).toEqual({
      basis: 'CBM',
      shares: [...ids]
        .sort()
        .map((shipmentId) => ({ shipmentId, value: shipmentId === ids[0] ? '2' : '3' })),
    });

    // The audit log names the container, who opened it and why.
    // A day either side: the log filters on the branch's local date, which may be tomorrow in UTC.
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const log = (
      await get(
        `/reports/audit-log?from=${day(-1)}&to=${day(1)}&entity=CONTAINER&userId=${opsJedId}`,
        cookies.admin,
      ).expect(200)
    ).body as AuditLogDto;
    expect(log.entries.find((e) => e.reference === closed.number)).toMatchObject({
      entity: 'CONTAINER',
      action: 'REVERT',
      status: 'OPEN',
      detail: 'Closed by mistake',
    });

    // Changed and closed again: the basis is frozen from the cargo as it is then.
    await t.prisma.shipmentItem.updateMany({
      where: { shipmentId: ids[0] },
      data: { volumeCbm: '4' },
    });
    await close(closed.id);
    const again = await container(closed.id);
    expect(again.status).toBe('CLOSED');
    expect(again.shipments.map((s) => s.basisValue).sort()).toEqual(['3', '4']);
    expect((await shipment(ids[0]!)).status).toBe('CONSOLIDATED');

    // The row is insert-only.
    await expect(
      t.prisma.consolidationReopening.updateMany({
        where: { consolidationId: closed.id },
        data: { reason: 'Changed' },
      }),
    ).rejects.toThrow();
  });

  it('replays a retry, refuses a reused key, and keeps a late request off a later close (ABA)', async () => {
    const id = await lclShipment('1');
    const closed = await closedContainer([id]);
    const first = await request(closed.id);
    await reopen(closed.id, first).expect(200);
    // The same request again: answered, nothing written twice.
    const replay = (await reopen(closed.id, first).expect(200)).body as ConsolidationDto;
    expect(replay.reopenRevision).toBe(1);
    expect(
      await t.prisma.consolidationReopening.count({ where: { consolidationId: closed.id } }),
    ).toBe(1);
    const reused = await reopen(closed.id, { ...first, reason: 'Another reason' });
    expect(reused.status).toBe(409);
    expect(code(reused)).toBe('CORRECTION_KEY_REUSED');

    // Closed again: the first request, late, returns its result and leaves the new close alone.
    await close(closed.id);
    const late = (await reopen(closed.id, first).expect(200)).body as ConsolidationDto;
    expect(late.status).toBe('CLOSED');
    expect(late.reopenRevision).toBe(1);
    // A request read before the first reopening, with a key of its own, is stale.
    const stale = await reopen(closed.id, { ...first, requestId: randomUUID() });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CORRECTION_STALE');
    expect(params(stale)).toEqual({ record: closed.number });
    expect((await container(closed.id)).status).toBe('CLOSED');
    // Read again, it goes through.
    await reopen(closed.id, await request(closed.id)).expect(200);
    expect((await container(closed.id)).reopenRevision).toBe(2);
  });

  it('is refused once a cost was charged, even after the bill is cancelled', async () => {
    const approvedCost = await closedContainer([await lclShipment('1')]);
    const bill = await approvedBill(approvedCost.id, d('03-03'));
    await approve(bill.id).expect(200);
    const refused = await reopen(approvedCost.id, await request(approvedCost.id));
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('CONTAINER_REOPEN_HAS_COSTS');
    expect(params(refused)).toEqual({ container: approvedCost.number });

    // Shared out at approval, then cancelled: the allocation entry stays, so does the refusal.
    await post(`/supplier-bills/${bill.id}/cancel`, cookies.financeJed, {
      reason: 'Billed twice',
    }).expect(200);
    const afterCancel = await reopen(approvedCost.id, await request(approvedCost.id));
    expect(afterCancel.status).toBe(409);
    expect(code(afterCancel)).toBe('CONTAINER_REOPEN_HAS_COSTS');
    expect((await container(approvedCost.id)).status).toBe('CLOSED');

    // A draft bill charges nothing yet.
    const drafted = await closedContainer([await lclShipment('1')]);
    await approvedBill(drafted.id, d('03-03'));
    await reopen(drafted.id, await request(drafted.id)).expect(200);
  });

  it('finds the close under the number the container had then (F129-1)', async () => {
    const id = await lclShipment('1');
    const closed = await closedContainer([id]);
    const renamed = `${closed.number}R`;
    await t.prisma.consolidation.update({ where: { id: closed.id }, data: { number: renamed } });
    await t.prisma.referenceRenumbering.create({
      data: {
        kind: 'CONSOLIDATION',
        recordId: closed.id,
        oldNumber: closed.number,
        newNumber: renamed,
        reason: 'MIGRATION',
      },
    });
    await reopen(closed.id, await request(closed.id)).expect(200);
    expect((await shipment(id)).status).toBe('CREATED');
  });

  it('is refused when a shipment moved on since the close, or once the container is loaded', async () => {
    const [still, held] = [await lclShipment('1'), await lclShipment('1')];
    const closed = await closedContainer([still, held]);
    await post(`/shipments/${held}/hold`, cookies.opsJed, { reason: 'Documents missing' }).expect(
      200,
    );
    const moved = await reopen(closed.id, await request(closed.id));
    expect(moved.status).toBe(409);
    expect(code(moved)).toBe('CONTAINER_REOPEN_SHIPMENT_MOVED');
    const heldNumber = (await shipment(held)).number;
    expect(params(moved)).toEqual({ container: closed.number, shipments: heldNumber });
    // Nothing was undone, not even for the shipment that had not moved.
    expect((await shipment(still)).status).toBe('CONSOLIDATED');
    expect((await container(closed.id)).status).toBe('CLOSED');

    const loaded = await closedContainer([await lclShipment('1')]);
    const body = await request(loaded.id);
    await post(`/consolidations/${loaded.id}/status`, cookies.opsJed, {
      status: 'LOADED',
      occurredAt: at('03-02'),
    }).expect(200);
    expect((await container(loaded.id)).actions.canReopen).toBe(false);
    const stale = await reopen(loaded.id, body);
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CORRECTION_STALE');
  });

  it("needs consolidation:cancel in the container's own branch", async () => {
    const id = await lclShipment('1');
    const closed = await closedContainer([id]);
    const body = await request(closed.id);
    // Finance reads containers without cancelling them.
    expect((await container(closed.id, cookies.financeJed)).actions.canReopen).toBe(false);
    await reopen(closed.id, body, cookies.financeJed).expect(403);
    // Another branch does not see the container.
    await reopen(closed.id, body, cookies.opsPts).expect(404);
    // Shared with PTS, its operations staff see it, but only the container's branch reopens it.
    await t.prisma.shipmentBranch.create({ data: { shipmentId: id, branchId: pts } });
    expect((await container(closed.id, cookies.opsPts)).actions.canReopen).toBe(false);
    await reopen(closed.id, body, cookies.opsPts).expect(403);
    expect((await container(closed.id)).status).toBe('CLOSED');
    await reopen(closed.id, body).expect(200);
  });

  it('races a supplier bill approval on the container: one or the other, never both', async () => {
    const closed = await closedContainer([await lclShipment('1')]);
    const bill = await approvedBill(closed.id, d('03-03'));
    const body = await request(closed.id);
    // Both wait on the container row, then go in turn.
    const { pending } = await t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "consolidations" WHERE "id" = ${closed.id}::uuid FOR UPDATE`;
      const started = Promise.all([approve(bill.id), reopen(closed.id, body)]);
      await waitForLockWaiter(t.prisma, 2);
      return { pending: started };
    });
    const [approval, reopening] = await pending;
    expect(approval.status).toBe(200);
    const line = await t.prisma.supplierBillLine.findFirstOrThrow({
      where: { billId: bill.id },
    });
    const after = await container(closed.id);
    if (reopening.status === 200) {
      // Reopened first: the bill found an open container and shared nothing out.
      expect(after.status).toBe('OPEN');
      expect(line.allocationEntryId).toBeNull();
    } else {
      // Approved first: the cost was shared out at the close's basis, and it stays closed.
      expect(code(reopening)).toBe('CONTAINER_REOPEN_HAS_COSTS');
      expect(after.status).toBe('CLOSED');
      expect(line.allocationEntryId).not.toBeNull();
    }
  });
});
