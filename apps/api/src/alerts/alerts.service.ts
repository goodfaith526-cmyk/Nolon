import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ALERT_KINDS,
  ALERT_LIST_LIMIT,
  type AlertDto,
  type AlertGroupDto,
  type AlertKind,
  type AlertSettingDto,
  type AlertsDto,
} from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { BillingReportsService } from '../billing/billing-reports.service.js';
import type { AlertRows } from '../common/alert-rows.js';
import { CustomsReportsService } from '../customs/customs-reports.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShipmentReportsService } from '../shipments/shipment-reports.service.js';
import { ShipmentsService } from '../shipments/shipments.service.js';
import { TripReportsService } from '../transport/trip-reports.service.js';
import { WarehouseReportsService } from '../warehouse/warehouse-reports.service.js';
import { concerns } from './alert-rules.js';

/** Alerts whose rows point at a shipment by id only: its number comes from the shipments module. */
const BY_SHIPMENT: readonly AlertKind[] = ['CUSTOMS_STALLED', 'STORAGE_EXCEEDED'];

/**
 * The internal alerts (scope section 15). Nothing is stored or sent: each alert is worked out when
 * it is asked for, by the module that owns its records, for the user's branches. A user gets the
 * alerts of the records they may see (ALERT_PERMISSIONS); a Driver gets only their own late trips.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly shipmentReports: ShipmentReportsService,
    private readonly billing: BillingReportsService,
    private readonly customs: CustomsReportsService,
    private readonly warehouse: WarehouseReportsService,
    private readonly trips: TripReportsService,
  ) {}

  /** The alerts this user is concerned by, each kind with its rows (most overdue first). */
  async forUser(user: AuthUser): Promise<AlertsDto> {
    const kinds = ALERT_KINDS.filter((kind) => concerns(user, kind));
    if (kinds.length === 0) return { groups: [], total: 0 };
    const waits = await this.waits();
    const groups = await Promise.all(
      kinds.map(async (kind): Promise<AlertGroupDto> => {
        const thresholdDays = waits.get(kind) ?? 0;
        const found = await this.rows(user, kind, thresholdDays);
        const items = await this.withNumbers(user, kind, found);
        return { kind, thresholdDays, count: found.count, items };
      }),
    );
    return { groups, total: groups.reduce((n, g) => n + g.count, 0) };
  }

  async settings(): Promise<AlertSettingDto[]> {
    const rows = await this.prisma.alertSetting.findMany({
      include: { updatedBy: { select: { fullName: true } } },
    });
    return ALERT_KINDS.flatMap((kind) => {
      const row = rows.find((r) => r.kind === kind);
      return row
        ? [
            {
              kind,
              days: row.days,
              updatedAt: row.updatedAt.toISOString(),
              updatedByName: row.updatedBy?.fullName ?? null,
            },
          ]
        : [];
    });
  }

  /** Changes how many days one alert waits: the only change the screens make to alerts. */
  async updateSetting(user: AuthUser, kind: AlertKind, days: number): Promise<AlertSettingDto[]> {
    const { count } = await this.prisma.alertSetting.updateMany({
      where: { kind },
      data: { days, updatedById: user.id },
    });
    if (count !== 1) throw new NotFoundException('Alert not found');
    return this.settings();
  }

  private async waits(): Promise<Map<AlertKind, number>> {
    const rows = await this.prisma.alertSetting.findMany();
    return new Map(rows.map((r) => [r.kind, r.days]));
  }

  private rows(user: AuthUser, kind: AlertKind, days: number): Promise<AlertRows> {
    switch (kind) {
      case 'SHIPMENT_PAST_ETA':
        return this.shipmentReports.pastEta(user, days, ALERT_LIST_LIMIT);
      case 'INVOICE_OVERDUE':
        return this.billing.overdueInvoices(user, days, ALERT_LIST_LIMIT);
      case 'CUSTOMS_STALLED':
        return this.customs.stalled(user, days, ALERT_LIST_LIMIT);
      case 'STORAGE_EXCEEDED':
        return this.warehouse.heldTooLong(user, days, ALERT_LIST_LIMIT);
      case 'TRIP_LATE':
        return this.trips.late(user, days, ALERT_LIST_LIMIT);
    }
  }

  private async withNumbers(
    user: AuthUser,
    kind: AlertKind,
    found: AlertRows,
  ): Promise<AlertDto[]> {
    if (!BY_SHIPMENT.includes(kind)) return found.rows.map((r) => ({ kind, ...r }));
    const summaries = await this.shipments.reportSummaries(user, [
      ...new Set(found.rows.map((r) => r.refId)),
    ]);
    const numbers = new Map(summaries.map((s) => [s.id, s.number]));
    return found.rows.flatMap((r) => {
      const number = numbers.get(r.refId);
      return number ? [{ kind, ...r, number }] : [];
    });
  }
}
