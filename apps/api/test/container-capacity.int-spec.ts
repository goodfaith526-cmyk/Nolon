import { randomInt } from 'node:crypto';
import type {
  BookingDto,
  ConsolidationBookingDto,
  ConsolidationDto,
  ConsolidationSummaryDto,
  ContainerFitDto,
  ContainerTypeDto,
  CustomerDto,
  MasterDataDto,
  Page,
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
import { codeEntityId } from '../src/audit/audit.service.js';
import { uniquePhone } from './test-data.js';

/**
 * A shared container's space (plan docs/reviews/lcl-numbering-capacity-plan-2026-10-27.md, PR-B):
 * CBM and weight against its type's limits, computed over every shipment in it; a write that takes
 * it over a limit is refused under the container's lock; closing and loading need every measure.
 * Each test uses container types of its own, so the seeded ones are never changed.
 */
describe('shared container capacity', () => {
  let t: TestApp;
  let jed: string;
  let pts: string;
  let jeddahPort: string;
  let portSudan: string;
  let customer: CustomerDto;
  const year = randomInt(1901, 2000);
  const at = (monthDay: string) => `${year}-${monthDay}T08:00:00+03:00`;
  const cookies = {
    admin: '',
    opsJed: '',
    salesJed: '',
    opsPts: '',
    salesPts: '',
    financeDxb: '',
  };

  const get = (path: string, cookie: string) =>
    t.http().get(`/api/v1${path}`).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object = {}) =>
    t.http().post(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    t.http().patch(`/api/v1${path}`).set('Origin', APP_ORIGIN).set('Cookie', cookie).send(body);

  /** A new container type with these limits (null: none). */
  async function containerType(
    maxVolumeCbm: string | null,
    maxPayloadKg: string | null,
  ): Promise<string> {
    const code = `ZC${randomInt(10_000_000, 99_999_999)}`;
    await post('/master-data/container-types', cookies.admin, {
      code,
      nameEn: `Test ${code}`,
      nameAr: `اختبار ${code}`,
    }).expect(201);
    await patch(`/master-data/container-types/${code}/capacity`, cookies.admin, {
      maxVolumeCbm,
      maxPayloadKg,
    }).expect(200);
    return code;
  }

  /** A confirmed Jeddah → Port Sudan LCL shipment with one cargo line; its id. */
  async function shipment(volumeCbm: string | null, weightKg: string | null): Promise<string> {
    const booking = (
      await post('/bookings', cookies.salesJed, {
        customerId: customer.id,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        mode: 'SEA',
        loadType: 'LCL',
        cargoType: 'GENERAL',
        services: ['MAIN_FREIGHT'],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg, volumeCbm }],
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

  async function newContainer(type: string, shipmentIds: string[] = []): Promise<ConsolidationDto> {
    return (
      await post('/consolidations', cookies.opsJed, {
        branchId: jed,
        originLocationId: jeddahPort,
        destinationLocationId: portSudan,
        containerTypeCode: type,
        containerNumber: 'MSCU1234565',
        shipmentIds,
      }).expect(201)
    ).body as ConsolidationDto;
  }

  const add = (id: string, shipmentId: string) =>
    post(`/consolidations/${id}/shipments`, cookies.opsJed, { shipmentId });
  const view = async (id: string, cookie = cookies.opsJed) =>
    (await get(`/consolidations/${id}`, cookie).expect(200)).body as ConsolidationDto;
  const close = (id: string) =>
    post(`/consolidations/${id}/status`, cookies.opsJed, {
      status: 'CLOSED',
      occurredAt: at('03-01'),
    });

  beforeAll(async () => {
    t = await createTestApp();
    jed = await branchId(t.prisma, 'JED');
    pts = await branchId(t.prisma, 'PTS');
    const loc = async (code: string) =>
      (await t.prisma.location.findUniqueOrThrow({ where: { code } })).id;
    jeddahPort = await loc('SAJED');
    portSudan = await loc('SDPZU');
    const users = {
      admin: await createUser(t.prisma, ['ADMINISTRATOR'], [], LEDGER_PREFIX),
      opsJed: await createUser(t.prisma, ['OPERATIONS'], ['JED'], LEDGER_PREFIX),
      salesJed: await createUser(t.prisma, ['SALES'], ['JED'], LEDGER_PREFIX),
      opsPts: await createUser(t.prisma, ['OPERATIONS'], ['PTS'], LEDGER_PREFIX),
      salesPts: await createUser(t.prisma, ['SALES'], ['PTS'], LEDGER_PREFIX),
      financeDxb: await createUser(t.prisma, ['FINANCE'], ['DXB'], LEDGER_PREFIX),
    };
    for (const key of Object.keys(users) as (keyof typeof users)[]) {
      cookies[key] = await signIn(t, users[key].email);
    }
    customer = (
      await post('/customers', cookies.salesJed, {
        branchId: jed,
        kind: 'COMPANY',
        name: `Capacity ${year}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
  });

  afterAll(async () => {
    await t.close();
  });

  it('seeds the standard types and lets only an administrator change a limit, in the audit log', async () => {
    const master = (await get('/master-data', cookies.opsJed).expect(200)).body as MasterDataDto;
    const byCode = new Map(master.containerTypes.map((c) => [c.code, c]));
    expect(byCode.get('20GP')).toMatchObject({ maxVolumeCbm: '28', maxPayloadKg: '28000' });
    expect(byCode.get('40GP')).toMatchObject({ maxVolumeCbm: '58', maxPayloadKg: '26500' });
    expect(byCode.get('40HC')).toMatchObject({ maxVolumeCbm: '68', maxPayloadKg: '26500' });
    expect(byCode.get('OTHER')).toMatchObject({ maxVolumeCbm: null, maxPayloadKg: null });

    const code = await containerType('10', null);
    const path = `/master-data/container-types/${code}/capacity`;
    await patch(path, cookies.opsJed, { maxVolumeCbm: '12' }).expect(403);
    for (const body of [
      {},
      { maxVolumeCbm: '0' },
      { maxVolumeCbm: '-1' },
      { maxVolumeCbm: 12 },
      { maxVolumeCbm: '1.23456' },
      { maxVolumeCbm: '1', nameEn: 'x' },
    ]) {
      await patch(path, cookies.admin, body).expect(400);
    }
    await patch('/master-data/container-types/ZCNONE/capacity', cookies.admin, {
      maxVolumeCbm: '1',
    }).expect(404);
    const changed = (await patch(path, cookies.admin, { maxPayloadKg: '1500.5' }).expect(200))
      .body as ContainerTypeDto;
    expect(changed).toMatchObject({ code, maxVolumeCbm: '10', maxPayloadKg: '1500.5' });

    const audit = await t.prisma.auditEvent.findMany({
      where: { entity: 'CONTAINER_TYPE', entityId: codeEntityId('CONTAINER_TYPE', code) },
      orderBy: { id: 'asc' },
    });
    expect(audit.at(-1)?.changes).toEqual([
      { field: 'maxPayloadKg', before: null, after: '1500.5' },
    ]);
    // The same values again change nothing and log nothing.
    await patch(path, cookies.admin, { maxPayloadKg: '1500.5' }).expect(200);
    expect(
      await t.prisma.auditEvent.count({
        where: { entity: 'CONTAINER_TYPE', entityId: codeEntityId('CONTAINER_TYPE', code) },
      }),
    ).toBe(audit.length);
  });

  it('shows the fill and refuses the shipment that would take it over a limit', async () => {
    const type = await containerType('10', '1000');
    const a = await shipment('4', '500');
    const created = await newContainer(type, [a]);
    expect(created.capacity.volumeCbm).toEqual({
      limit: '10',
      used: '4',
      remaining: '6',
      fillPercent: '40',
      complete: true,
    });
    expect(created.capacity.weightKg.fillPercent).toBe('50');
    expect(created.fillPercent).toBe('50');
    expect(created.capacity.asOfNow).toBe(false);

    // Exactly at the limit is accepted.
    const b = await shipment('4', '500');
    await add(created.id, b).expect(201);
    const c = await shipment('1', '0.5');
    const fit = (
      await get(`/consolidations/${created.id}/fit?shipmentIds=${c}`, cookies.opsJed).expect(200)
    ).body as ContainerFitDto[];
    expect(fit).toEqual([
      {
        shipmentId: c,
        fits: false,
        over: ['weightKg'],
        unchecked: [],
        volumeCbm: '1',
        weightKg: '0.5',
        remainingVolumeCbm: '1',
        remainingWeightKg: '-0.5',
      },
    ]);
    const refused = await add(created.id, c).expect(409);
    expect(refused.body).toMatchObject({
      code: 'CONTAINER_OVER_WEIGHT',
      params: { container: created.number, used: '1000', limit: '1000', after: '1000.5' },
    });
    expect(
      await t.prisma.consolidationShipment.count({ where: { consolidationId: created.id } }),
    ).toBe(2);

    // A container made with too much in it is refused whole.
    const big = await shipment('11', '1');
    const tooBig = await post('/consolidations', cookies.opsJed, {
      branchId: jed,
      originLocationId: jeddahPort,
      destinationLocationId: portSudan,
      containerTypeCode: type,
      shipmentIds: [big],
    }).expect(409);
    expect(tooBig.body).toMatchObject({ code: 'CONTAINER_OVER_VOLUME' });
    expect(await t.prisma.consolidationShipment.count({ where: { shipmentId: big } })).toBe(0);

    const list = (
      await get(`/consolidations?q=${encodeURIComponent(created.number)}`, cookies.opsJed).expect(
        200,
      )
    ).body as Page<ConsolidationSummaryDto>;
    expect(list.items.find((i) => i.id === created.id)).toMatchObject({
      fillPercent: '100',
      fillIncomplete: false,
    });
  });

  it('counts cargo without a measure as not checked, never as zero, and closes only when measured', async () => {
    const type = await containerType('10', '1000');
    const measured = await shipment('3', '100');
    const noVolume = await shipment(null, '100');
    const created = await newContainer(type, [measured, noVolume]);
    const shown = await view(created.id);
    expect(shown.capacity.volumeCbm).toMatchObject({ used: '3', complete: false });
    expect(shown.capacity.weightKg).toMatchObject({ used: '200', complete: true });
    const noVolumeNumber = (await t.prisma.shipment.findUniqueOrThrow({ where: { id: noVolume } }))
      .number;
    expect(shown.capacity.incomplete).toEqual([
      { shipmentId: noVolume, shipmentNumber: noVolumeNumber, missing: ['volumeCbm'] },
    ]);
    expect(shown.fillIncomplete).toBe(true);
    const fit = (
      await get(`/consolidations/${created.id}/fit?shipmentIds=${noVolume}`, cookies.opsJed)
    ).body as ContainerFitDto[];
    expect(fit[0]).toMatchObject({ unchecked: ['volumeCbm'], volumeCbm: null });

    // Unmeasured volume adds nothing known: a shipment without CBM still goes in when its weight fits.
    await add(created.id, await shipment(null, '100')).expect(201);

    const refused = await close(created.id).expect(400);
    expect(refused.body).toMatchObject({ code: 'CONTAINER_VOLUME_MISSING' });
    const { params } = refused.body as { params: { shipments: string } };
    expect(params.shipments).toContain(noVolumeNumber);
    expect((await view(created.id)).status).toBe('OPEN');

    // A type that limits neither measure closes without them (the cost basis still needs CBM).
    const free = await containerType(null, null);
    const unlimited = await newContainer(free, [await shipment('1', null)]);
    expect(unlimited.fillPercent).toBeNull();
    expect(unlimited.capacity.weightKg).toMatchObject({ limit: null, complete: false });
    await close(unlimited.id).expect(200);
    // A weight limit set after the close: loading needs the weight now.
    await patch(`/master-data/container-types/${free}/capacity`, cookies.admin, {
      maxPayloadKg: '1000',
    }).expect(200);
    const load = await post(`/consolidations/${unlimited.id}/status`, cookies.opsJed, {
      status: 'LOADED',
      occurredAt: at('03-02'),
    }).expect(400);
    expect(load.body).toMatchObject({ code: 'CONTAINER_WEIGHT_MISSING' });
    expect((await view(unlimited.id)).status).toBe('CLOSED');
  });

  it('shows another branch the totals but only its own shipments as unmeasured', async () => {
    const type = await containerType('10', '1000');
    const jedShipment = await shipment('2', null);
    const created = await newContainer(type, [jedShipment]);
    const ptsCustomer = (
      await post('/customers', cookies.salesPts, {
        branchId: pts,
        kind: 'COMPANY',
        name: `Capacity PTS ${randomInt(1_000_000)}`,
        phone: uniquePhone(),
        preferredCurrency: 'USD',
      }).expect(201)
    ).body as CustomerDto;
    // PTS books its own customer into JED's open container, its cargo without a weight.
    const made = (
      await post(`/consolidations/${created.id}/bookings`, cookies.opsPts, {
        customerId: ptsCustomer.id,
        destinationLocationId: portSudan,
        cargoType: 'GENERAL',
        services: [],
        items: [{ cargoType: 'GENERAL', quantity: 1, weightKg: null, volumeCbm: '3' }],
      }).expect(201)
    ).body as ConsolidationBookingDto;

    const own = await view(created.id);
    expect(own.capacity.volumeCbm).toMatchObject({ used: '5', complete: true });
    expect(own.capacity.incomplete.map((i) => i.shipmentId).sort()).toEqual(
      [jedShipment, made.shipmentId].sort(),
    );
    const guest = await view(created.id, cookies.opsPts);
    expect(guest.ownBranch).toBe(false);
    expect(guest.capacity.volumeCbm).toEqual(own.capacity.volumeCbm);
    expect(guest.capacity.weightKg).toEqual(own.capacity.weightKg);
    expect(guest.capacity.incomplete).toEqual([
      { shipmentId: made.shipmentId, shipmentNumber: made.shipmentNumber, missing: ['weightKg'] },
    ]);
    // A branch with nothing in it and no booking right does not see the container at all.
    await get(`/consolidations/${created.id}`, cookies.financeDxb).expect(404);
    // The estimate: shipments the user sees only, for those who add shipments.
    const fitPath = `/consolidations/${created.id}/fit?shipmentIds=`;
    await get(`${fitPath}${jedShipment}`, cookies.opsPts).expect(404);
    await get(`${fitPath}${jedShipment}`, cookies.salesJed).expect(403);
    await get(`${fitPath}nope`, cookies.opsJed).expect(400);
    await get(`${fitPath}${made.shipmentId}`, cookies.opsPts).expect(200);
  });

  it('lets one of two racing shipments in when only one fits', async () => {
    const type = await containerType('10', null);
    const created = await newContainer(type);
    const [a, b] = [await shipment('6', '1'), await shipment('6', '1')];
    const results = await Promise.all([add(created.id, a), add(created.id, b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await view(created.id)).capacity.volumeCbm.used).toBe('6');
  });

  it('refuses a move into a full container, and a type that cannot hold the load', async () => {
    const small = await containerType('5', null);
    const large = await containerType('10', null);
    const unlimited = await containerType(null, null);
    const s = await shipment('4', '1');
    const source = await newContainer(large, [s]);
    const target = await newContainer(small, [await shipment('2', '1')]);
    const moved = await post(`/consolidations/${source.id}/shipments/${s}/move`, cookies.opsJed, {
      consolidationId: target.id,
    }).expect(409);
    expect(moved.body).toMatchObject({ code: 'CONTAINER_OVER_VOLUME' });
    expect((await view(source.id)).shipments.map((x) => x.shipmentId)).toEqual([s]);

    // A type that limits less than the load is refused; one that holds it, or has no limit, is not.
    const tiny = await containerType('3', null);
    const typeRefused = await patch(`/consolidations/${source.id}`, cookies.opsJed, {
      containerTypeCode: tiny,
    }).expect(409);
    expect(typeRefused.body).toMatchObject({
      code: 'CONTAINER_OVER_VOLUME',
      params: { used: '4', limit: '3' },
    });
    await patch(`/consolidations/${source.id}`, cookies.opsJed, {
      containerTypeCode: small,
    }).expect(200);
    await patch(`/consolidations/${source.id}`, cookies.opsJed, {
      containerTypeCode: unlimited,
    }).expect(200);
    await patch(`/consolidations/${source.id}`, cookies.opsJed, {
      containerTypeCode: large,
    }).expect(200);
  });

  it('keeps a container whose limit was lowered, refusing only what adds to it, and shows a closed one as of now', async () => {
    const type = await containerType('10', '1000');
    const created = await newContainer(type, [await shipment('8', '100')]);
    await patch(`/master-data/container-types/${type}/capacity`, cookies.admin, {
      maxVolumeCbm: '6',
    }).expect(200);
    let shown = await view(created.id);
    expect(shown.capacity.volumeCbm).toMatchObject({
      limit: '6',
      remaining: '-2',
      fillPercent: '133.3',
    });
    // Over already: adding more CBM is refused, adding weight only is not.
    await add(created.id, await shipment('0.5', '1')).expect(409);
    const weightOnly = await shipment(null, '1');
    await add(created.id, weightOnly).expect(201);
    // Closing checks the measures and the totals again.
    expect((await close(created.id).expect(400)).body).toMatchObject({
      code: 'CONTAINER_VOLUME_MISSING',
    });
    await t
      .http()
      .delete(`/api/v1/consolidations/${created.id}/shipments/${weightOnly}`)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookies.opsJed)
      .expect(200);
    const refused = await close(created.id).expect(409);
    expect(refused.body).toMatchObject({ code: 'CONTAINER_OVER_VOLUME' });

    await patch(`/master-data/container-types/${type}/capacity`, cookies.admin, {
      maxVolumeCbm: '8',
    }).expect(200);
    await close(created.id).expect(200);
    await patch(`/master-data/container-types/${type}/capacity`, cookies.admin, {
      maxVolumeCbm: '16',
    }).expect(200);
    shown = await view(created.id);
    expect(shown.capacity).toMatchObject({
      asOfNow: true,
      volumeCbm: { limit: '16', used: '8', fillPercent: '50' },
    });
  });
});
