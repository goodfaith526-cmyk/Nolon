import { Injectable } from '@nestjs/common';
import type { DashboardDto, Permission } from '@nolon/shared';
import type { AuthUser } from '../auth/auth-user.js';
import { BookingsService } from '../bookings/bookings.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { QuotationsService } from '../quotations/quotations.service.js';
import { RatesService } from '../rates/rates.service.js';

const COUNT = { page: 1, pageSize: 1 } as const;
const RECENT = { page: 1, pageSize: 5 } as const;

/**
 * Home page figures. Each figure comes from the owning module's own (branch-scoped) list, so the
 * dashboard shows exactly what the user could open, and only for modules they may view.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly customers: CustomersService,
    private readonly rates: RatesService,
    private readonly quotations: QuotationsService,
    private readonly bookings: BookingsService,
  ) {}

  async summary(user: AuthUser): Promise<DashboardDto> {
    const can = (permission: Permission) => user.permissions.has(permission);
    const [customers, rates, quotations, bookings] = await Promise.all([
      can('customers:view') ? this.customerFigures(user) : null,
      can('rates:view') ? this.rateFigures(user) : null,
      can('quotations:view') ? this.quotationFigures(user) : null,
      can('bookings:view') ? this.bookingFigures(user) : null,
    ]);
    return { customers, rates, quotations, bookings };
  }

  private async customerFigures(user: AuthUser) {
    const page = await this.customers.list(user, COUNT);
    return { total: page.total };
  }

  private async rateFigures(user: AuthUser) {
    const [draft, approved] = await Promise.all([
      this.rates.list(user, { ...COUNT, status: 'DRAFT' }),
      this.rates.list(user, { ...COUNT, status: 'APPROVED' }),
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
