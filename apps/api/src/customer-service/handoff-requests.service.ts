import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { CsHandoffCreated, CsHandoffRequestDto, CsSenderChannel } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { type AlertRows, type AlertSqlRow, alertRows } from '../common/alert-rows.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { uuidList } from '../common/report-sql.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CsHandoffRequest } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ApiClientAuth } from './api-client.guard.js';
import { matchPlace } from './bot-names.js';

export interface HandoffInput {
  idempotencyKey: string;
  channel: CsSenderChannel;
  sender: string;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  reason: string;
  bookingRequestRef?: string | undefined;
  branchHint?: string | undefined;
}

function coded(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ message, code, statusCode: status }, status);
}

/** SHA-256 of the body without its idempotency key, keys sorted, absent fields as null. */
export function handoffHash(input: HandoffInput): string {
  const fields = (Object.keys(input) as (keyof HandoffInput)[])
    .filter((k) => k !== 'idempotencyKey')
    .sort();
  const canonical = fields.map((k) => [k, input[k] ?? null]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const toStatus = (row: { status: 'OPEN' | 'CONTACTED' }) =>
  row.status === 'OPEN' ? ('open' as const) : ('contacted' as const);

/**
 * 2026-11-12 (owner: «اخطار الموظف يكون في السيستم احسن»): a customer asked the bot for a person.
 * The bot's key sends it; the branch comes from the departure city's routing rules, capped by the
 * key's branches. When the city names no single branch, every branch the key serves sees it, so
 * no request is lost. Staff of those branches mark it contacted.
 */
@Injectable()
export class HandoffRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masterData: MasterDataService,
  ) {}

  /** Made once per key and idempotency key; the same key with other content is a 409. */
  async create(
    client: ApiClientAuth,
    input: HandoffInput,
  ): Promise<{ created: boolean; body: CsHandoffCreated }> {
    const hash = handoffHash(input);
    const known = await this.replay(client.id, input.idempotencyKey, hash);
    if (known) return { created: false, body: known };

    const keyBranches = [...client.allowedBranchIds];
    if (keyBranches.length === 0) throw new NotFoundException('The key serves no branch');
    const routed = input.branchHint ? await this.route(input.branchHint, keyBranches) : [];
    const branchId = routed.length === 1 ? (routed[0] ?? null) : null;
    const allowed = routed.length > 1 ? routed : keyBranches;

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const number = formatDocumentNumber('HR', await nextSequenceValue(tx, 'HANDOFF_REQUEST'));
        return tx.csHandoffRequest.create({
          data: {
            number,
            apiClientId: client.id,
            idempotencyKey: input.idempotencyKey,
            contentHash: hash,
            channel: input.channel,
            senderId: input.sender,
            customerName: input.customerName ?? null,
            customerPhone: input.customerPhone ?? null,
            reason: input.reason,
            bookingRequestRef: input.bookingRequestRef ?? null,
            branchHint: input.branchHint ?? null,
            branchId,
            allowedBranchIds: allowed,
          },
        });
      });
      return { created: true, body: { id: row.id, status: toStatus(row) } };
    } catch (e) {
      // Two sends of the same key at once: the second reads what the first made.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.replay(client.id, input.idempotencyKey, hash);
        if (again) return { created: false, body: again };
      }
      throw e;
    }
  }

  /** The bot reads back only what its own key made. */
  async status(client: ApiClientAuth, id: string): Promise<CsHandoffCreated> {
    const row = await this.prisma.csHandoffRequest.findFirst({
      where: { id, apiClientId: client.id },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundException('Handoff request not found');
    return { id: row.id, status: toStatus(row) };
  }

  /** The requests of the user's branches, open first, newest first. */
  async list(user: AuthUser, state: 'open' | 'all'): Promise<CsHandoffRequestDto[]> {
    const branchIds = reportBranchIds(user);
    if (branchIds.length === 0) return [];
    const rows = await this.prisma.csHandoffRequest.findMany({
      where: {
        ...this.visibleTo(branchIds),
        ...(state === 'open' ? { status: 'OPEN' as const } : {}),
      },
      include: { contactedBy: { select: { fullName: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map(toDto);
  }

  /** Marks one request contacted, by the user, once. A request outside their branches is a 404. */
  async markContacted(user: AuthUser, id: string): Promise<CsHandoffRequestDto> {
    const branchIds = reportBranchIds(user);
    const { count } = await this.prisma.csHandoffRequest.updateMany({
      where: { id, status: 'OPEN', ...this.visibleTo(branchIds) },
      data: { status: 'CONTACTED', contactedById: user.id, contactedAt: new Date() },
    });
    const row = await this.prisma.csHandoffRequest.findFirst({
      where: { id, ...this.visibleTo(branchIds) },
      include: { contactedBy: { select: { fullName: true } } },
    });
    if (!row) throw new NotFoundException('Handoff request not found');
    if (count === 0 && row.status !== 'CONTACTED')
      throw coded(HttpStatus.CONFLICT, 'NOT_OPEN', 'This request is not open');
    return toDto(row);
  }

  /** Alert HANDOFF_REQUEST_OPEN: open requests older than `graceDays`, in the user's branches. */
  async openAlerts(user: AuthUser, graceDays: number, limit: number): Promise<AlertRows> {
    const branchIds = reportBranchIds(user);
    if (branchIds.length === 0) return { count: 0, rows: [] };
    const branches = Prisma.sql`ARRAY[${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))}]`;
    const zone = Prisma.sql`coalesce(b."timezone", 'UTC')`;
    return alertRows(
      await this.prisma.$queryRaw<AlertSqlRow[]>`
        SELECT *, count(*) OVER ()::int AS "count" FROM (
          SELECT h."id" AS "refId", h."number", coalesce(b."code", '') AS "branchCode",
                 coalesce(h."customer_name", h."customer_phone") AS "detail",
                 (h."created_at" AT TIME ZONE ${zone})::date AS "since",
                 ((now() AT TIME ZONE ${zone})::date
                   - (h."created_at" AT TIME ZONE ${zone})::date)::int AS "days"
          FROM "cs_handoff_requests" h
          LEFT JOIN "branches" b ON b."id" = h."branch_id"
          WHERE h."status" = 'OPEN'
            AND (h."branch_id" IN ${uuidList(branchIds)}
                 OR (h."branch_id" IS NULL AND h."allowed_branch_ids" && ${branches}))
        ) a
        WHERE a."days" >= ${graceDays}
        ORDER BY a."since", a."number"
        LIMIT ${limit}`,
    );
  }

  private visibleTo(branchIds: readonly string[]): Prisma.CsHandoffRequestWhereInput {
    return {
      OR: [
        { branchId: { in: [...branchIds] } },
        { branchId: null, allowedBranchIds: { hasSome: [...branchIds] } },
      ],
    };
  }

  /** The key's branches the city's routing rules name (none when the city is not matched). */
  private async route(hint: string, keyBranches: readonly string[]): Promise<string[]> {
    const [all, aliases] = await Promise.all([
      this.masterData.all(),
      this.masterData.locationAliases(),
    ]);
    const places = all.locations
      .filter((l) => l.isActive && l.kind !== 'COUNTRY')
      .map((l) => ({ ...l, aliases: aliases[l.id] ?? [] }));
    const placeId = matchPlace({ ar: hint, en: hint }, places);
    if (placeId === null) return [];
    const candidates = await this.masterData.routingCandidates(placeId);
    return candidates.filter((b) => keyBranches.includes(b));
  }

  private async replay(
    apiClientId: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<CsHandoffCreated | null> {
    const row = await this.prisma.csHandoffRequest.findUnique({
      where: { apiClientId_idempotencyKey: { apiClientId, idempotencyKey } },
      select: { id: true, status: true, contentHash: true },
    });
    if (!row) return null;
    if (row.contentHash !== hash)
      throw coded(
        HttpStatus.CONFLICT,
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key was used for another request',
      );
    return { id: row.id, status: toStatus(row) };
  }
}

function toDto(
  row: CsHandoffRequest & { contactedBy: { fullName: string } | null },
): CsHandoffRequestDto {
  return {
    id: row.id,
    number: row.number,
    status: toStatus(row),
    channel: row.channel as CsSenderChannel,
    senderId: row.senderId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    reason: row.reason,
    bookingRequestRef: row.bookingRequestRef,
    branchHint: row.branchHint,
    branchId: row.branchId,
    createdAt: row.createdAt.toISOString(),
    contactedAt: row.contactedAt?.toISOString() ?? null,
    contactedByName: row.contactedBy?.fullName ?? null,
  };
}
