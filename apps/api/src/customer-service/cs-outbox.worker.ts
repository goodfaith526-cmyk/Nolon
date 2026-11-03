import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { CsWebhookEventBody, CsWebhookEventType } from '@nolon/shared';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type DeliveryResult,
  type NoticeTransport,
  checkEndpointUrl,
  noticeHeaders,
} from './webhook-delivery.js';

/** The transport the worker sends with (tests replace it; production uses httpsTransport()). */
export const CS_NOTICE_TRANSPORT = Symbol('CS_NOTICE_TRANSPORT');

/** How often the worker looks for notices due. */
const TICK_MS = 5_000;
/** Notices leased per round; a lease lasts long enough for all of them to time out in turn. */
const BATCH = 20;
const LEASE_SECONDS = 60 + BATCH * 10;
/** A notice not delivered within a day of being written is given up (FAILED, shown to admin). */
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60 * 1000;

interface Leased {
  id: string;
  apiClientId: string;
  requestId: string;
  sequence: number;
  type: CsWebhookEventType;
  occurredAt: Date;
  attempts: number;
  createdAt: Date;
}

export interface OutboxRound {
  leased: number;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
}

/** The wait before attempt `attempts + 1`: 30 s doubling, at most an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

/**
 * What the receiver's answer means (contract of 2026-11-03): 2xx delivered; 400 a notice it will
 * never take; anything else (401 key, 404 unknown request yet, 503 busy, 3xx, no answer) again
 * later, until a day has passed.
 */
export function outcomeOf(
  result: DeliveryResult,
  attempts: number,
  createdAt: Date,
  now: Date,
): { status: 'SENT' | 'FAILED' | 'PENDING'; nextAttemptAt: Date | null } {
  if (result.status !== null && result.status >= 200 && result.status < 300) {
    return { status: 'SENT', nextAttemptAt: null };
  }
  if (result.status === 400) return { status: 'FAILED', nextAttemptAt: null };
  const next = new Date(now.getTime() + retryDelayMs(attempts));
  if (next.getTime() > createdAt.getTime() + GIVE_UP_MS) {
    return { status: 'FAILED', nextAttemptAt: null };
  }
  return { status: 'PENDING', nextAttemptAt: next };
}

/**
 * Plan 09 section 5: sends the outbox, at least once per notice. A round leases due notices with
 * one atomic UPDATE (FOR UPDATE SKIP LOCKED: two workers never lease the same row), then sends each
 * outside any transaction. A worker that stops after sending and before recording sends again once
 * the lease ends; the receiver drops a repeated `eventId`. Before each send the key must still be
 * active with its booking scope, the request's branch still one of the key's, and the endpoint
 * still approved; otherwise the notice is CANCELLED_BY_POLICY, unsent. Off unless
 * CS_WEBHOOK_WORKER_ENABLED; nothing is sent without CS_WEBHOOK_SECRET.
 */
@Injectable()
export class CsOutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CsOutboxWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(CS_NOTICE_TRANSPORT) private readonly transport: NoticeTransport,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.CS_WEBHOOK_WORKER_ENABLED) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .then(
          (round) => {
            if (round.leased > 0) this.logger.log(`Outbox round: ${JSON.stringify(round)}`);
          },
          (error: unknown) => this.logger.error('Outbox round failed', error),
        )
        .finally(() => {
          this.running = false;
        });
    }, TICK_MS).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now: Date = new Date()): Promise<OutboxRound> {
    const round: OutboxRound = { leased: 0, sent: 0, retried: 0, failed: 0, cancelled: 0 };
    const secret = this.env.CS_WEBHOOK_SECRET;
    if (!secret) return round;
    const leased = await this.prisma.$queryRaw<Leased[]>`
      UPDATE "cs_outbox" SET "status" = 'SENDING',
        "lease_until" = ${now}::timestamptz + make_interval(secs => ${LEASE_SECONDS}),
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "cs_outbox"
        WHERE "status" IN ('PENDING', 'SENDING')
          AND ("lease_until" IS NULL OR "lease_until" < ${now}::timestamptz)
          AND "next_attempt_at" <= ${now}::timestamptz
        ORDER BY "next_attempt_at", "request_id", "sequence"
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH})
      RETURNING "id", "api_client_id" AS "apiClientId", "request_id" AS "requestId", "sequence",
        "type", "occurred_at" AS "occurredAt", "attempts", "created_at" AS "createdAt"`;
    round.leased = leased.length;
    leased.sort((a, b) =>
      a.requestId === b.requestId ? a.sequence - b.sequence : a.requestId < b.requestId ? -1 : 1,
    );
    for (const notice of leased) {
      // Codex F172-3: a notice past its 24 hours is never sent, however late the worker runs
      // (switched off, down, or a lease recovered after the deadline).
      if (now.getTime() > notice.createdAt.getTime() + GIVE_UP_MS) {
        await this.record(notice, { status: 'FAILED', lastError: 'EXPIRED' });
        round.failed += 1;
        continue;
      }
      const endpoint = await this.allowedEndpoint(notice);
      if (!endpoint) {
        await this.record(notice, { status: 'CANCELLED_BY_POLICY', lastError: 'POLICY' });
        round.cancelled += 1;
        continue;
      }
      const payload: CsWebhookEventBody = {
        eventId: notice.id,
        type: notice.type,
        requestId: notice.requestId,
        sequence: notice.sequence,
        occurredAt: notice.occurredAt.toISOString(),
      };
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const timestamp = Math.floor(Date.now() / 1000);
      const result = await this.transport.send(
        endpoint.url,
        noticeHeaders(secret, endpoint.audience, notice.apiClientId, timestamp, body),
        body,
      );
      const outcome = outcomeOf(result, notice.attempts, notice.createdAt, new Date());
      await this.record(notice, {
        status: outcome.status,
        nextAttemptAt: outcome.nextAttemptAt ?? undefined,
        sentAt: outcome.status === 'SENT' ? new Date() : undefined,
        lastStatus: result.status,
        lastError: result.error,
      });
      if (outcome.status === 'SENT') round.sent += 1;
      else if (outcome.status === 'FAILED') round.failed += 1;
      else round.retried += 1;
    }
    return round;
  }

  /** The approved endpoint, when the key may still be told about this request. */
  private async allowedEndpoint(notice: Leased): Promise<{ url: string; audience: string } | null> {
    const key = await this.prisma.apiClient.findUnique({
      where: { id: notice.apiClientId },
      select: {
        isActive: true,
        scopes: { where: { scope: 'BOOKING_REQUESTS_CREATE' }, select: { scope: true } },
        branches: { select: { branchId: true } },
      },
    });
    if (!key?.isActive || key.scopes.length === 0) return null;
    const request = await this.prisma.csBookingRequest.findUnique({
      where: { id: notice.requestId },
      select: { branchId: true, allowedBranchIds: true },
    });
    if (!request) return null;
    const served = new Set(key.branches.map((b) => b.branchId));
    const branches = request.branchId === null ? request.allowedBranchIds : [request.branchId];
    if (!branches.some((b) => served.has(b))) return null;
    const endpoint = await this.prisma.csWebhookEndpoint.findFirst({
      where: { apiClientId: notice.apiClientId, status: 'APPROVED' },
      select: { url: true, audience: true },
    });
    // Codex F172-1: the address must pass today's rules (HTTPS, 443, a host still allowed), not
    // only those of the day it was approved; the transport still guards the resolved address.
    if (!endpoint || 'problem' in checkEndpointUrl(endpoint.url, this.env.CS_WEBHOOK_ALLOWED_HOSTS))
      return null;
    return endpoint;
  }

  /**
   * Writes the outcome only while this worker's lease holds (same attempt, still SENDING): a
   * worker whose lease ended and was taken over records nothing.
   */
  private async record(
    notice: Leased,
    data: {
      status: string;
      nextAttemptAt?: Date;
      sentAt?: Date;
      lastStatus?: number | null;
      lastError?: string | null;
    },
  ): Promise<void> {
    await this.prisma.csOutboxEvent.updateMany({
      where: { id: notice.id, status: 'SENDING', attempts: notice.attempts },
      data: { ...data, leaseUntil: null, lastError: data.lastError?.slice(0, 300) ?? null },
    });
  }
}
