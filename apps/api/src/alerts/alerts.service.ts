import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ALERT_KINDS,
  ALERT_LIST_LIMIT,
  type AlertDto,
  type AlertGroupDto,
  type AlertKind,
  type AlertSettingDto,
  type AlertsDto,
  ALERT_PERMISSIONS,
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
import { withPermissions } from '../auth/branch-scope.js';

/**
 * Starting waits of alerts added after alert_settings was created: used until the Administrator
 * sets one (then a row holds it). Days before the ETA for SHIPMENT_ARRIVING_SOON.
 */
const DEFAULT_DAYS: Partial<Record<AlertKind, number>> = { SHIPMENT_ARRIVING_SOON: 3 };

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

  /** The alerts this user is concerned by, each kind with its rows (most urgent first). */
  async forUser(user: AuthUser): Promise<AlertsDto> {
    const kinds = ALERT_KINDS.filter((kind) => concerns(user, kind));
    if (kinds.length === 0) return { groups: [], total: 0 };
    const waits = await this.waits();
    const groups = await Promise.all(
      kinds.map(async (kind): Promise<AlertGroupDto> => {
        const thresholdDays = waits.get(kind) ?? 0;
        // Only the branches where they hold the alert's permission (plan 03, section 5.3).
        const scoped = withPermissions(user, ALERT_PERMISSIONS[kind]);
        const found = await this.rows(scoped, kind, thresholdDays);
        const items = await this.withNumbers(scoped, kind, found);
        return { kind, thresholdDays, count: found.count, items };
      }),
    );
    return { groups, total: groups.reduce((n, g) => n + g.count, 0) };
  }

  /** Home page: how many rows each alert of this user has (forUser without the rows). */
  async counts(user: AuthUser): Promise<{ kind: AlertKind; count: number }[]> {
    const kinds = ALERT_KINDS.filter((kind) => concerns(user, kind));
    if (kinds.length === 0) return [];
    const waits = await this.waits();
    return Promise.all(
      kinds.map(async (kind) => {
        const scoped = withPermissions(user, ALERT_PERMISSIONS[kind]);
        const found = await this.rows(scoped, kind, waits.get(kind) ?? 0);
        return { kind, count: found.count };
      }),
    );
  }

  async settings(): Promise<AlertSettingDto[]> {
    const rows = await this.prisma.alertSetting.findMany({
      include: { updatedBy: { select: { fullName: true } } },
    });
    return ALERT_KINDS.flatMap((kind): AlertSettingDto[] => {
      const row = rows.find((r) => r.kind === kind);
      if (row) {
        return [
          {
            kind,
            days: row.days,
            updatedAt: row.updatedAt.toISOString(),
            updatedByName: row.updatedBy?.fullName ?? null,
          },
        ];
      }
      // Never set: its starting wait, shown as not changed by anyone.
      const days = DEFAULT_DAYS[kind];
      return days === undefined ? [] : [{ kind, days, updatedAt: null, updatedByName: null }];
    });
  }

  /** Changes how many days one alert waits: the only change the screens make to alerts. */
  async updateSetting(user: AuthUser, kind: AlertKind, days: number): Promise<AlertSettingDto[]> {
    if (DEFAULT_DAYS[kind] !== undefined) {
      // An alert with a starting wait may have no row yet: the first change adds it.
      await this.prisma.alertSetting.upsert({
        where: { kind },
        create: { kind, days, updatedById: user.id },
        update: { days, updatedById: user.id },
      });
      return this.settings();
    }
    const { count } = await this.prisma.alertSetting.updateMany({
      where: { kind },
      data: { days, updatedById: user.id },
    });
    if (count !== 1) throw new NotFoundException('Alert not found');
    return this.settings();
  }

  private async waits(): Promise<Map<AlertKind, number>> {
    const rows = await this.prisma.alertSetting.findMany();
    return new Map([
      ...(Object.entries(DEFAULT_DAYS) as [AlertKind, number][]),
      ...rows.map((r): [AlertKind, number] => [r.kind, r.days]),
    ]);
  }

  private rows(user: AuthUser, kind: AlertKind, days: number): Promise<AlertRows> {
    switch (kind) {
      case 'SHIPMENT_ARRIVING_SOON':
        return this.shipmentReports.arrivingSoon(user, days, ALERT_LIST_LIMIT);
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
