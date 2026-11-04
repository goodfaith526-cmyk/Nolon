import { Injectable } from '@nestjs/common';
import { CUSTOMER_STAGE_STAFF_STATUSES, type CsWebhookEventType } from '@nolon/shared';
import type { Prisma } from '../generated/prisma/client.js';
import {
  type ShipmentStatusChange,
  ShipmentStatusListenersRegistry,
} from '../shipments/shipment-status-listeners.registry.js';

type Tx = Prisma.TransactionClient;

/** Always staff, whatever the mapping says (customer-stages.ts). */
const STAFF_STATUSES: ReadonlySet<string> = new Set(CUSTOMER_STAGE_STAFF_STATUSES);

/**
 * Plan 09 section 5 (N-C5): the outbox of notices, one numbered stream per request. Every notice
 * is written in the transaction that makes the change (a decision, a cancel, a shipment status),
 * so a rolled back change leaves no notice and a committed one always has its notice. Notices are
 * written only for a key with an approved endpoint; the worker sends them later.
 */
@Injectable()
export class CsEventsService {
  constructor(shipmentStatus: ShipmentStatusListenersRegistry) {
    shipmentStatus.register((tx, change) => this.onShipmentStatusInTx(tx, change));
  }

  /**
   * Numbers `types` with the request's next sequence numbers (in order, without gaps between them)
   * and queues them. Nothing when the request's key has no approved endpoint.
   */
  async emitInTx(
    tx: Tx,
    request: { id: string; apiClientId: string },
    types: readonly CsWebhookEventType[],
    occurredAt: Date = new Date(),
  ): Promise<void> {
    if (types.length === 0) return;
    const endpoint = await tx.csWebhookEndpoint.findFirst({
      where: { apiClientId: request.apiClientId, status: 'APPROVED' },
      select: { id: true },
    });
    if (!endpoint) return;
    const [row] = await tx.$queryRaw<{ seq: number }[]>`
      UPDATE "cs_booking_requests" SET "event_seq" = "event_seq" + ${types.length}
      WHERE "id" = ${request.id}::uuid RETURNING "event_seq" AS "seq"`;
    if (!row) return;
    const first = row.seq - types.length + 1;
    await tx.csOutboxEvent.createMany({
      data: types.map((type, i) => ({
        apiClientId: request.apiClientId,
        requestId: request.id,
        sequence: first + i,
        type,
        occurredAt,
        nextAttemptAt: occurredAt,
      })),
    });
  }

  /**
   * A shipment made from an approved bot request changed status: `shipment.stage_changed` when the
   * customer's stage really changed (not every internal status is a new stage), and
   * `shipment.delivered` on delivery. The last stage announced is kept on the request.
   */
  private async onShipmentStatusInTx(tx: Tx, change: ShipmentStatusChange): Promise<void> {
    const request = await tx.csBookingRequest.findFirst({
      where: { bookingId: change.bookingId, status: 'APPROVED' },
      select: { id: true, apiClientId: true, lastStageCode: true },
    });
    if (!request) return;
    const types: CsWebhookEventType[] = [];
    const stage = await stageCodeInTx(tx, change.status);
    if (stage !== null && stage !== request.lastStageCode) {
      await tx.$executeRaw`
        UPDATE "cs_booking_requests" SET "last_stage_code" = ${stage}
        WHERE "id" = ${request.id}::uuid`;
      types.push('shipment.stage_changed');
    }
    if (change.status === 'DELIVERED') types.push('shipment.delivered');
    await this.emitInTx(tx, request, types, change.occurredAt);
  }
}

/** The active customer stage a shipment status shows as, or null (staff, unmapped, inactive). */
async function stageCodeInTx(tx: Tx, status: string): Promise<string | null> {
  if (STAFF_STATUSES.has(status)) return null;
  const rows = await tx.$queryRaw<{ code: string }[]>`
    SELECT s."code" FROM "shipment_status_stages" m
    JOIN "customer_stages" s ON s."code" = m."stage_code"
    WHERE m."status"::text = ${status} AND s."is_active"`;
  return rows[0]?.code ?? null;
}
