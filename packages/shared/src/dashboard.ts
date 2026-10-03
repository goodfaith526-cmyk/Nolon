import type { BookingSummaryDto, QuotationSummaryDto } from './commercial.js';

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
