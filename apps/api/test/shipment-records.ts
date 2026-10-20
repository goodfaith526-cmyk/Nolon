import { todayIn } from '../src/common/dates.js';
import { APP_ORIGIN, type TestApp } from './auth-test-app.js';

/** A PNG signature header is enough for the content check (magic bytes). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

/**
 * The records that set a shipment's status of their own (functional review Z1): tests that need
 * a shipment at customs or delivered make the record, as staff do, since the generic status
 * change refuses those statuses.
 */
export function shipmentRecords(t: TestApp) {
  return {
    /** Saves the customs file in progress (submitted), or cleared today in the shipment's branch. */
    async customs(shipmentId: string, cookie: string, cleared: boolean): Promise<void> {
      const { branch } = await t.prisma.shipment.findUniqueOrThrow({
        where: { id: shipmentId },
        select: { branch: { select: { timezone: true } } },
      });
      await t
        .http()
        .put(`/api/v1/shipments/${shipmentId}/customs`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .send(
          cleared
            ? { status: 'CLEARED', clearedOn: todayIn(branch.timezone) }
            : { status: 'SUBMITTED' },
        )
        .expect(200);
    },

    /** A proof of delivery with no trip, moving the shipment to `status`; the request to expect. */
    pod(shipmentId: string, cookie: string, status: 'PARTIALLY_DELIVERED' | 'DELIVERED') {
      return t
        .http()
        .post(`/api/v1/shipments/${shipmentId}/pods`)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', cookie)
        .field('recipientName', 'Ahmed Ali')
        .field('recipientCapacity', 'Consignee')
        .field('shipmentStatus', status)
        .attach('signature', PNG, 'signature.png');
    },
  };
}
