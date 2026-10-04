import type { BookingSummaryDto, QuotationSummaryDto } from './commercial.js';
import type { DecimalString } from './currencies.js';
import type { ReportBranchDto, ReportLocationDto } from './reports.js';
import type { ShipmentStatus } from './shipments.js';
import type { TripStatus } from './transport.js';

/**
 * GET /dashboard: the signed-in user's home page, within their branches. A section is null when
 * the user lacks that module's view permission.
 */
export interface DashboardDto {
  customers: { total: number } | null;
  rates: { draft: number; approved: number } | null;
  quotations: {
    draft: number;
    sent: number;
    approved: number;
    recent: QuotationSummaryDto[];
  } | null;
  bookings: { draft: number; confirmed: number; recent: BookingSummaryDto[] } | null;
}

/**
 * The two dashboards of annex D section 2, both needing dashboards:view, over a period (default:
 * this month to date) in the user's branches. Like the home page, a section is null when the user
 * lacks the module's view permission: shipments (shipments:view), finance and top customers
 * (financial_reports:view), warehouse (warehouse:view), trips (transport_trips:view). There are no
 * alerts yet (alert rules are not built), so there is no alerts section.
 */
export interface DashboardShipmentsDto {
  /** Shipments not delivered, closed or cancelled, by their status now. */
  byStatus: { status: ShipmentStatus; count: number }[];
  open: number;
  /** Created in the period. */
  newInPeriod: number;
  /** First delivered in the period. */
  deliveredInPeriod: number;
  /** Open shipments whose ETA is before today. */
  late: number;
}

export interface DashboardBranchFinanceDto extends ReportBranchDto {
  /** Posted revenue, expenses and their difference in the period (income statement). */
  revenueUsd: DecimalString;
  costUsd: DecimalString;
  profitUsd: DecimalString;
}

export interface DashboardFinanceDto {
  branches: DashboardBranchFinanceDto[];
  totals: { revenueUsd: DecimalString; costUsd: DecimalString; profitUsd: DecimalString };
  /** Approved invoices past their due date and still open at the period's end (AR aging). */
  overdueReceivablesUsd: DecimalString;
}

export interface DashboardTopCustomerDto {
  customerId: string;
  customerName: string;
  invoices: number;
  revenueUsd: DecimalString;
}

/** GET /dashboard/management */
export interface ManagementDashboardDto {
  from: string;
  to: string;
  branchId: string | null;
  shipments: DashboardShipmentsDto | null;
  finance: DashboardFinanceDto | null;
  /** The five customers with the most approved invoice revenue in the period. */
  topCustomers: DashboardTopCustomerDto[] | null;
}

export interface DashboardShipmentRefDto {
  shipmentId: string;
  number: string;
  customerName: string;
  status: ShipmentStatus;
  origin: ReportLocationDto;
  destination: ReportLocationDto;
}

export interface DashboardTripRefDto {
  tripId: string;
  number: string;
  status: TripStatus;
  vehicle: string | null;
  driver: string | null;
  origin: ReportLocationDto;
  destination: ReportLocationDto;
}

/** GET /dashboard/branch: the management figures for one branch, and its day. */
export interface BranchDashboardDto extends ManagementDashboardDto {
  branch: ReportBranchDto;
  /** Today in the branch's time zone. */
  today: string;
  /** Not cancelled shipments of the branch due to arrive (ETA) or leave (ETD) today. */
  todayShipments: {
    inbound: DashboardShipmentRefDto[];
    outbound: DashboardShipmentRefDto[];
  } | null;
  warehouse: {
    shipments: number;
    packages: number;
    weightKg: DecimalString;
    receivedToday: number;
    releasedToday: number;
  } | null;
  /** Trips departed and not yet completed or cancelled; planned ones counted. */
  trips: { active: DashboardTripRefDto[]; planned: number } | null;
}
