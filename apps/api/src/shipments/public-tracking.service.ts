import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  PublicLocationDto,
  PublicTrackingDto,
  PublicTrackingLookupResponse,
} from '@nolon/shared';
import { fromDbDateOrNull } from '../common/dates.js';
import { FailureLimiter, type LimitRule } from '../common/failure-limiter.js';
import { APP_ENV, type AppEnv } from '../config/env.js';
import type { Location } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { publicStatus, publicTimeline, replayHistory } from './state-machine.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** Per shipment number: 5 wrong phone digits in 15 minutes blocks lookups of that number. */
export const REFERENCE_RULE: LimitRule = {
  maxFailures: 5,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};

/** Per client IP: 30 failed lookups or unknown links in 15 minutes. */
export const TRACKING_IP_RULE: LimitRule = {
  maxFailures: 30,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};

/**
 * All clients together: 300 failed lookups in 15 minutes pauses lookups by number for everyone.
 * A backstop for when the per-IP limit is off (staging, until the proxies pass the client IP):
 * guessing 4 digits across many shipment numbers stays slow. Links by token are not affected.
 */
export const TRACKING_GLOBAL_RULE: LimitRule = {
  maxFailures: 300,
  windowMs: FIFTEEN_MINUTES,
  blockMs: FIFTEEN_MINUTES,
};

const GLOBAL_KEY = 'global';

const NO_MATCH = 'No shipment matches this number and phone';

/**
 * Public tracking (annex B section 6), no sign-in. Returns only the safe fields: reference,
 * public status, city/port, origin and destination, ETA and the public timeline. Never names,
 * phones, weights, amounts or internal notes. Cancelled shipments are not shown.
 */
@Injectable()
export class PublicTrackingService {
  private readonly referenceLimiter = new FailureLimiter(REFERENCE_RULE);
  private readonly ipLimiter = new FailureLimiter(TRACKING_IP_RULE);
  private readonly globalLimiter = new FailureLimiter(TRACKING_GLOBAL_RULE);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async byToken(token: string, ip: string | undefined): Promise<PublicTrackingDto> {
    const ipKey = this.ipKey(ip);
    if (ipKey && this.ipLimiter.isBlocked(ipKey)) throw tooMany();
    const shipment = await this.prisma.shipment.findUnique({
      where: { trackingToken: token },
      include: {
        origin: true,
        destination: true,
        currentLocation: true,
        events: { orderBy: { id: 'asc' }, include: { location: true } },
      },
    });
    if (!shipment || shipment.status === 'CANCELLED') {
      if (ipKey) this.ipLimiter.recordFailure(ipKey);
      throw new NotFoundException('Tracking link not found');
    }
    const locations = new Map(
      shipment.events.flatMap((e) => (e.location ? [[e.location.id, e.location] as const] : [])),
    );
    const timeline = publicTimeline(replayHistory(shipment.events));
    const current = timeline.at(-1);
    return {
      reference: shipment.number,
      mode: shipment.mode,
      status: current?.status ?? publicStatus('CREATED') ?? 'REGISTERED',
      origin: toPublicLocation(shipment.origin),
      destination: toPublicLocation(shipment.destination),
      currentLocation: shipment.currentLocation ? toPublicLocation(shipment.currentLocation) : null,
      eta: fromDbDateOrNull(shipment.eta),
      timeline: timeline.map((entry) => {
        const location = entry.locationId ? locations.get(entry.locationId) : undefined;
        return {
          status: entry.status,
          occurredAt: entry.occurredAt.toISOString(),
          location: location ? toPublicLocation(location) : null,
        };
      }),
    };
  }

  /**
   * Finds a shipment by its number and the last 4 digits of a phone registered on it (the
   * customer, the consignee, or a contact allowed to inquire) and returns its tracking token.
   * Every failure looks the same, so the answer does not reveal whether the number exists.
   */
  async lookup(
    reference: string,
    phoneLast4: string,
    ip: string | undefined,
  ): Promise<PublicTrackingLookupResponse> {
    const number = reference.trim().toUpperCase();
    const referenceKey = `ref:${number}`;
    const ipKey = this.ipKey(ip);
    if (
      this.referenceLimiter.isBlocked(referenceKey) ||
      (ipKey && this.ipLimiter.isBlocked(ipKey)) ||
      this.globalLimiter.isBlocked(GLOBAL_KEY)
    ) {
      throw tooMany();
    }
    const shipment = await this.prisma.shipment.findUnique({
      where: { number },
      select: {
        status: true,
        trackingToken: true,
        consignee: { select: { phone: true } },
        customer: {
          select: {
            phone: true,
            contacts: { where: { isActive: true, canInquire: true }, select: { phone: true } },
          },
        },
      },
    });
    const phones = shipment
      ? [
          shipment.customer.phone,
          shipment.consignee?.phone,
          ...shipment.customer.contacts.map((c) => c.phone),
        ]
      : [];
    const matches =
      shipment !== null &&
      shipment.status !== 'CANCELLED' &&
      phones.some((phone) => phone?.endsWith(phoneLast4));
    if (!shipment || !matches) {
      this.referenceLimiter.recordFailure(referenceKey);
      if (ipKey) this.ipLimiter.recordFailure(ipKey);
      this.globalLimiter.recordFailure(GLOBAL_KEY);
      throw new NotFoundException(NO_MATCH);
    }
    this.referenceLimiter.reset(referenceKey);
    return { token: shipment.trackingToken };
  }

  /** Same switch as sign-in: per-IP limits only once the proxies pass the real client IP. */
  private ipKey(ip: string | undefined): string | undefined {
    return this.env.LOGIN_IP_LIMIT_ENABLED && ip ? `ip:${ip}` : undefined;
  }
}

function tooMany(): HttpException {
  return new HttpException('Too many attempts, try again later', HttpStatus.TOO_MANY_REQUESTS);
}

function toPublicLocation(location: Location): PublicLocationDto {
  return { code: location.code, nameEn: location.nameEn, nameAr: location.nameAr };
}
