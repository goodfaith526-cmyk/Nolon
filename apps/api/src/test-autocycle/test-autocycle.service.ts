import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { CsApprovalPriceDto } from '@nolon/shared';
import { readAccessVersion } from '../access-control/access-loader.js';
import { runWithRequestAccess } from '../access-control/request-access.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AuthService } from '../auth/auth.service.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import { BookingReviewService } from '../customer-service/booking-review.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WindowCollectService } from '../window-desk/window-collect.service.js';
import { WindowDeskService } from '../window-desk/window-desk.service.js';
import {
  AUTOCYCLE_LOOKBACK_MS,
  AUTOCYCLE_RETRY_MS,
  AUTOCYCLE_STAFF,
  AUTOCYCLE_WINDOW,
  NO_LOGIN_HASH,
  approvalBody,
  approvalPlan,
  autocycleAllowed,
  isTestRequest,
  packagesOf,
  paymentRequestId,
} from './test-autocycle.js';

/** How often the autocycle looks for test requests with a step due. */
const TICK_MS = 5_000;

export interface AutocycleRound {
  approved: number;
  received: number;
  paid: number;
  failed: number;
}

/**
 * Owner, 2026-11-07, staging only (autocycleAllowed): a bot request whose sender's name holds
 * «اختبار» goes through the cycle staff and the window would take it through, as the system's
 * test users, CS_TEST_AUTOCYCLE_DELAY_S apart:
 *
 * 1. approval as «Test Autocycle» (an Administrator), with the body the approval form sends as it
 *    opens: the engine's price, the request's route and currency, its drop-off point
 *    (BookingReviewService.approve, every check of the button; CS_APPROVE_CONFIRMS_ENABLED then
 *    confirms the booking and makes its invoice);
 * 2. the goods received at the booking's window as «Test Autocycle (window)», an Outlet Staff user
 *    of the window's outlet: as many packages as the request has items, GOOD
 *    (WindowDeskService.receive);
 * 3. the invoice's whole balance paid at that window in its currency
 *    (WindowCollectService.collect, which approves the pro forma and posts the receipt).
 *
 * Every step is the service's own, so the audit log, the booking's notices to the bot and the
 * waybill and receipt (plan 13-5) are the ordinary ones, under the test users' names. A request
 * whose name lacks the word, older than a day, or approved by anyone else is never touched. A
 * step that fails is logged and tried again after AUTOCYCLE_RETRY_MS. Each round's steps run one
 * after another, and rounds never overlap (runOnce), so one API process never repeats a step; a retry of
 * the payment reuses its request id (paymentRequestId), so it is never taken twice.
 */
@Injectable()
export class TestAutocycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TestAutocycleService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Request id -> when its next step may be tried again after a failure. */
  private readonly retryAt = new Map<string, number>();
  /** Requests whose cycle ended (paid, or not one the window can take). */
  private readonly finished = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly review: BookingReviewService,
    private readonly desk: WindowDeskService,
    private readonly collector: WindowCollectService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.CS_TEST_AUTOCYCLE_ENABLED && !autocycleAllowed(this.env)) {
      this.logger.error('CS_TEST_AUTOCYCLE_ENABLED is ignored: this is not the staging stack');
      return;
    }
    if (!autocycleAllowed(this.env)) return;
    this.logger.warn(
      `Test autocycle ON: requests named «اختبار» are completed every ${this.env.CS_TEST_AUTOCYCLE_DELAY_S} s`,
    );
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .then(
          (round) => {
            if (round.approved + round.received + round.paid + round.failed > 0)
              this.logger.log(`Test autocycle round: ${JSON.stringify(round)}`);
          },
          (error: unknown) => this.logger.error('Test autocycle round failed', error),
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

  /**
   * One round: every step due now, one after another. Nothing at all while not allowed. A round
   * asked for while one runs (the timer's, or a test's) starts after it, never beside it.
   */
  runOnce(now: Date = new Date()): Promise<AutocycleRound> {
    const next = this.queue.then(() => this.round(now));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async round(now: Date): Promise<AutocycleRound> {
    const round: AutocycleRound = { approved: 0, received: 0, paid: 0, failed: 0 };
    if (!autocycleAllowed(this.env)) return round;
    const delayMs = this.env.CS_TEST_AUTOCYCLE_DELAY_S * 1000;
    const since = new Date(now.getTime() - AUTOCYCLE_LOOKBACK_MS);
    const due = new Date(now.getTime() - delayMs);

    const pending = (
      await this.prisma.csBookingRequest.findMany({
        where: {
          status: 'PENDING',
          branchId: { not: null },
          createdAt: { gte: since, lte: due },
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, senderName: true, otherSenderName: true },
      })
    ).filter((r) => isTestRequest(r) && !this.finished.has(r.id) && this.mayTry(r.id, now));
    if (pending.length > 0) {
      const staffId = await this.staffUserId();
      for (const r of pending) {
        await this.step(r.id, now, round, async () => {
          if (await this.approveOne(staffId, r.id)) round.approved += 1;
        });
      }
    }

    const staff = await this.prisma.user.findUnique({
      where: { email: AUTOCYCLE_STAFF.email },
      select: { id: true },
    });
    if (!staff) return round;
    const approved = (
      await this.prisma.csBookingRequest.findMany({
        where: {
          status: 'APPROVED',
          decidedById: staff.id,
          decidedAt: { gte: since, lte: due },
          bookingId: { not: null },
        },
        orderBy: { decidedAt: 'asc' },
        select: {
          id: true,
          senderName: true,
          otherSenderName: true,
          bookingId: true,
          _count: { select: { items: true } },
        },
      })
    ).filter((r) => isTestRequest(r) && !this.finished.has(r.id) && this.mayTry(r.id, now));
    for (const r of approved) {
      await this.step(r.id, now, round, async () => {
        const done = await this.windowStep(r, due, round);
        if (done) this.finished.add(r.id);
      });
    }
    return round;
  }

  private mayTry(requestId: string, now: Date): boolean {
    return (this.retryAt.get(requestId) ?? 0) <= now.getTime();
  }

  private async step(
    requestId: string,
    now: Date,
    round: AutocycleRound,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await fn();
      this.retryAt.delete(requestId);
    } catch (error) {
      round.failed += 1;
      this.retryAt.set(requestId, now.getTime() + AUTOCYCLE_RETRY_MS);
      this.logger.warn(
        `Test autocycle: request ${requestId} failed, tried again in ${AUTOCYCLE_RETRY_MS / 60_000} min: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Approves one pending request as the form would, as the staff test user. */
  private async approveOne(staffId: string, requestId: string): Promise<boolean> {
    const actor = await this.actor(staffId);
    return runWithRequestAccess(actor.access.version, async () => {
      const dto = await this.review.detail(actor, requestId);
      if (dto.status !== 'pending' || dto.branchId === null) return false;
      const branch = await this.prisma.branch.findUnique({
        where: { id: dto.branchId },
        select: { defaultCurrency: true },
      });
      const plan = approvalPlan(dto, branch?.defaultCurrency ?? null);
      if (typeof plan === 'string') {
        // Left for staff: never tried again.
        this.finished.add(requestId);
        this.logger.warn(`Test autocycle: request ${dto.reference} left for staff: ${plan}`);
        return false;
      }
      const prices: CsApprovalPriceDto[] = [];
      for (const line of plan.lines)
        prices.push(await this.review.price(actor, requestId, { ...plan.inputs, ...line }));
      await this.review.approve(actor, requestId, approvalBody(dto, plan, prices));
      this.logger.log(`Test autocycle: approved ${dto.reference}`);
      return true;
    });
  }

  /**
   * The window's next step for an approved request: receive, then collect. True when nothing is
   * left (paid, or a booking no window takes).
   */
  private async windowStep(
    r: {
      id: string;
      senderName: string;
      otherSenderName: string | null;
      bookingId: string | null;
      _count: { items: number };
    },
    due: Date,
    round: AutocycleRound,
  ): Promise<boolean> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: r.bookingId! },
      select: {
        id: true,
        number: true,
        status: true,
        branchId: true,
        dropOff: { select: { partnerId: true } },
      },
    });
    if (!booking || booking.status !== 'CONFIRMED' || !booking.dropOff?.partnerId) {
      this.logger.warn(
        `Test autocycle: booking ${booking?.number ?? r.bookingId} stops here (not confirmed, or no window)`,
      );
      return true;
    }
    const windowUserId = await this.windowUserId(booking.dropOff.partnerId, booking.branchId);
    const actor = await this.actor(windowUserId);
    return runWithRequestAccess(actor.access.version, async () => {
      const desk = await this.desk.booking(actor, booking.id);
      if (!desk.received) {
        await this.desk.receive(actor, booking.id, {
          packages: packagesOf(r._count.items),
          condition: 'GOOD',
          partyName: r.otherSenderName ?? r.senderName,
          note: 'Test Autocycle',
        });
        round.received += 1;
        this.logger.log(`Test autocycle: received ${booking.number} at ${desk.window.code}`);
        return false;
      }
      if (!desk.todo.includes('collect')) return true;
      if (!desk.invoice) return false; // The invoice is made on confirmation; wait for it.
      const lastReceipt = Math.max(...desk.receipts.map((m) => Date.parse(m.occurredAt)));
      if (lastReceipt > due.getTime()) return false;
      await this.collector.collect(actor, booking.id, {
        requestId: paymentRequestId(r.id),
        amount: desk.invoice.balance,
        currency: desk.invoice.currency,
        reference: 'TEST-AUTOCYCLE',
      });
      round.paid += 1;
      this.logger.log(
        `Test autocycle: paid ${desk.invoice.balance} ${desk.invoice.currency} on ${booking.number}`,
      );
      return true;
    });
  }

  private async actor(userId: string): Promise<AuthUser> {
    const actor = await this.auth.actorFor(userId);
    if (!actor) throw new Error('The test autocycle user is inactive');
    return actor;
  }

  /**
   * «Test Autocycle», an Administrator made on first use (a change of access, as the users
   * screen's). Made once; deactivating it on the users screen stops the approvals.
   */
  private async staffUserId(): Promise<string> {
    const found = await this.prisma.user.findUnique({
      where: { email: AUTOCYCLE_STAFF.email },
      select: { id: true },
    });
    if (found) return found.id;
    const version = await readAccessVersion(this.prisma);
    return this.prisma.changeAccess(version, async (tx) => {
      const user = await tx.user.create({
        data: {
          ...AUTOCYCLE_STAFF,
          passwordHash: NO_LOGIN_HASH,
          roles: { create: [{ role: 'ADMINISTRATOR' }] },
        },
        select: { id: true },
      });
      return user.id;
    });
  }

  /**
   * «Test Autocycle (window)», an Outlet Staff user, linked to the window's outlet and its branch
   * when not yet (a change of access). Links are only added, never removed here.
   */
  private async windowUserId(partnerId: string, branchId: string): Promise<string> {
    const found = await this.prisma.user.findUnique({
      where: { email: AUTOCYCLE_WINDOW.email },
      select: {
        id: true,
        branches: { where: { branchId }, select: { branchId: true } },
        outlets: { where: { partnerId }, select: { partnerId: true } },
      },
    });
    if (found && found.branches.length > 0 && found.outlets.length > 0) return found.id;
    const version = await readAccessVersion(this.prisma);
    return this.prisma.changeAccess(version, async (tx) => {
      const user =
        found ??
        (await tx.user.create({
          data: {
            ...AUTOCYCLE_WINDOW,
            passwordHash: NO_LOGIN_HASH,
            roles: { create: [{ role: 'OUTLET_STAFF' }] },
          },
          select: { id: true },
        }));
      await tx.userBranch.createMany({
        data: [{ userId: user.id, branchId }],
        skipDuplicates: true,
      });
      await tx.userPartner.createMany({
        data: [{ userId: user.id, partnerId }],
        skipDuplicates: true,
      });
      this.logger.log('Test autocycle: window user linked to a new outlet');
      return user.id;
    });
  }
}
