import { Injectable } from '@nestjs/common';
import type { DashboardDto, Permission } from '@nolon/shared';
import { AlertsService } from '../alerts/alerts.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { CustomsReportsService } from '../customs/customs-reports.service.js';
import { MyDraftsService } from '../my-drafts/my-drafts.service.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import { RatesService } from '../rates/rates.service.js';
import { TripReportsService } from '../transport/trip-reports.service.js';
import { WarehouseReportsService } from '../warehouse/warehouse-reports.service.js';
import { withPermissions } from '../auth/branch-scope.js';

const COUNT = { page: 1, pageSize: 1 } as const;
const RECENT = { page: 1, pageSize: 5 } as const;

/**
 * Home page figures. Each figure comes from the owning module's own (branch-scoped) list or
 * report, so the dashboard shows exactly what the user could open, and only for modules they may
 * view: the sales figures, then each role's own (warehouse, customs, trips), the assistant drafts
 * they may decide, and their alerts.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly customers: CustomersService,
    private readonly rates: RatesService,
    private readonly quotations: QuotationsService,
    private readonly bookings: BookingsService,
    private readonly warehouse: WarehouseReportsService,
    private readonly customs: CustomsReportsService,
    private readonly trips: TripReportsService,
    private readonly drafts: MyDraftsService,
    private readonly alerts: AlertsService,
  ) {}

  async summary(user: AuthUser): Promise<DashboardDto> {
    // Each part covers the branches where its permission is held (plan 03, section 5.3).
    const can = (permission: Permission) => user.access.any(permission);
    const as = (permission: Permission) => withPermissions(user, permission);
    const [customers, rates, quotations, bookings, warehouse, customs, trips, drafts, alerts] =
      await Promise.all([
        can('customers:view') ? this.customerFigures(as('customers:view')) : null,
        can('rates:view') ? this.rateFigures() : null,
        can('quotations:view') ? this.quotationFigures(as('quotations:view')) : null,
        can('bookings:view') ? this.bookingFigures(as('bookings:view')) : null,
        can('warehouse:view') ? this.warehouse.dashboard(as('warehouse:view')) : null,
        can('customs:view') ? this.customs.open(as('customs:view')) : null,
        can('transport_trips:view') ? this.trips.home(as('transport_trips:view')) : null,
        this.drafts.awaitingReview(user),
        this.alerts.counts(user),
      ]);
    return {
      customers,
      rates,
      quotations,
      bookings,
      warehouse: warehouse && { ...warehouse, weightKg: warehouse.weightKg.toFixed() },
      customs: customs && { open: customs.reduce((n, s) => n + s.count, 0), byStatus: customs },
      trips,
      drafts: drafts === null ? null : { awaitingReview: drafts },
      alerts:
        alerts.length === 0
          ? null
          : { total: alerts.reduce((n, a) => n + a.count, 0), byKind: alerts },
    };
  }

  private async customerFigures(user: AuthUser) {
    const page = await this.customers.list(user, COUNT);
    return { total: page.total };
  }

  /** Rate cards are shared by every branch: the figures are the company's. */
  private async rateFigures() {
    const [draft, approved] = await Promise.all([
      this.rates.list({ ...COUNT, status: 'DRAFT' }),
      this.rates.list({ ...COUNT, status: 'APPROVED' }),
    ]);
    return { draft: draft.total, approved: approved.total };
  }

  private async quotationFigures(user: AuthUser) {
    const [draft, sent, approved, recent] = await Promise.all([
      this.quotations.list(user, { ...COUNT, status: 'DRAFT' }),
      this.quotations.list(user, { ...COUNT, status: 'SENT' }),
      this.quotations.list(user, { ...COUNT, status: 'APPROVED' }),
      this.quotations.list(user, RECENT),
    ]);
    return {
      draft: draft.total,
      sent: sent.total,
      approved: approved.total,
      recent: recent.items,
    };
  }

  private async bookingFigures(user: AuthUser) {
    const [draft, confirmed, recent] = await Promise.all([
      this.bookings.list(user, { ...COUNT, status: 'DRAFT' }),
      this.bookings.list(user, { ...COUNT, status: 'CONFIRMED' }),
      this.bookings.list(user, RECENT),
    ]);
    return { draft: draft.total, confirmed: confirmed.total, recent: recent.items };
  }
}
