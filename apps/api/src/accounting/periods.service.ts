import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { FiscalPeriodDto } from '@nolon/shared';
import { fromDbDate, toDbDate, todayIn } from '../common/dates.js';
import type { FiscalPeriod, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Monthly accounting periods (scope 13). A period is created the first time something is dated
 * in it. Closing is final in phase 1: nothing posts into a closed period, which the journal
 * trigger also enforces.
 */
@Injectable()
export class PeriodsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<FiscalPeriodDto[]> {
    const periods = await this.prisma.fiscalPeriod.findMany({
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return periods.map(toDto);
  }

  /** The open period containing `date`, created if needed. 409 when it is closed. */
  async requireOpen(tx: Tx, date: string): Promise<string> {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const start = `${date.slice(0, 7)}-01`;
    const end = fromDbDate(new Date(Date.UTC(year, month, 0)));
    await tx.$executeRaw`
      INSERT INTO "fiscal_periods" ("id", "year", "month", "start_date", "end_date")
      VALUES (gen_random_uuid(), ${year}, ${month}, ${toDbDate(start)}, ${toDbDate(end)})
      ON CONFLICT ("year", "month") DO NOTHING`;
    // Share lock: a concurrent close waits for this transaction, and this one sees a close that
    // committed first.
    const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT "id", "status"::text AS "status" FROM "fiscal_periods"
      WHERE "year" = ${year} AND "month" = ${month} FOR SHARE`;
    const period = rows[0];
    if (!period) throw new Error(`Period ${year}-${month} missing`);
    if (period.status !== 'OPEN') {
      throw new ConflictException(`The period ${date.slice(0, 7)} is closed`);
    }
    return period.id;
  }

  /**
   * Closes a period that has ended. Refused while it holds draft entries, since they could never
   * be posted afterwards.
   */
  async close(userId: string, id: string): Promise<FiscalPeriodDto> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "fiscal_periods" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('Period not found');
      const period = await tx.fiscalPeriod.findUniqueOrThrow({ where: { id } });
      if (period.status === 'CLOSED') throw new ConflictException('The period is already closed');
      if (fromDbDate(period.endDate) >= todayIn('UTC')) {
        throw new ConflictException('A period can be closed only after it ends');
      }
      const drafts = await tx.journalEntry.count({ where: { periodId: id, status: 'DRAFT' } });
      if (drafts > 0) {
        throw new ConflictException(`Post or delete the ${drafts} draft entries in this period`);
      }
      const closed = await tx.fiscalPeriod.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: new Date(), closedById: userId },
      });
      return toDto(closed);
    });
  }
}

function toDto(p: FiscalPeriod): FiscalPeriodDto {
  return {
    id: p.id,
    year: p.year,
    month: p.month,
    startDate: fromDbDate(p.startDate),
    endDate: fromDbDate(p.endDate),
    status: p.status,
    closedAt: p.closedAt?.toISOString() ?? null,
  };
}
