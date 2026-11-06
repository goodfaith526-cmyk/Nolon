import type { BookingItemDto, ShippingMode } from './commercial.js';
import type { CurrencyCode, DecimalString } from './currencies.js';
import type { CsDropOffDto } from './customer-service.js';
import type { GoodsCondition } from './warehouse.js';

/**
 * Plan 13 section 2: the window's desk. A partner outlet that runs a window (drop-off point) sees
 * the CONFIRMED bookings whose goods are to be handed over at its windows: who brings them, what,
 * and what the customer owes. Read only; never the customer's file, other bookings or costs.
 */
export const WINDOW_DESK_FILTERS = ['expected', 'received', 'all'] as const;
export type WindowDeskFilter = (typeof WINDOW_DESK_FILTERS)[number];

/** What is left for the window to do on a booking. */
export type WindowDeskTodo = 'receive' | 'collect';

/** GET /window-desk/expected, GET /window-desk/bookings/:id. */
export interface WindowDeskBookingDto {
  bookingId: string;
  bookingNumber: string;
  /** The booking's branch (the window's), whose header the printouts carry. */
  branchId: string;
  /** The booking's shipment, the number the goods travel under. */
  shipmentNumber: string;
  confirmedAt: string | null;
  /** The booking's sender as written on it (its shipper, else its customer). */
  sender: { name: string; phone: string | null };
  /** The booking's receiver (its consignee), when it names one. */
  receiver: { name: string; phone: string | null; city: string | null } | null;
  originLocationId: string;
  destinationLocationId: string;
  mode: ShippingMode;
  items: BookingItemDto[];
  /** The window the goods are handed over at (one of the outlet's), and the outlet that runs it. */
  window: CsDropOffDto & { id: string; code: string; outletName: string | null };
  /**
   * The shipment's MAIN invoice (not cancelled), or null while it has none: what the customer
   * pays. `balance` is the total less what is paid. No cost or margin.
   */
  invoice: {
    number: string | null;
    status: 'DRAFT' | 'APPROVED';
    currency: CurrencyCode;
    total: DecimalString;
    balance: DecimalString;
  } | null;
  /** True once the goods have a live goods receipt (GRN). */
  received: boolean;
  /** Plan 13 section 3: the live goods receipts made at this window, oldest first. */
  receipts: WindowDeskReceiptDto[];
  /** Plan 13 section 4: the customer's payments taken at this window, oldest first. */
  payments: WindowDeskPaymentDto[];
  todo: WindowDeskTodo[];
}

/** A goods receipt (GRN) made at the window, as its printout shows it. */
export interface WindowDeskReceiptDto {
  id: string;
  number: string;
  occurredAt: string;
  packages: number;
  weightKg: DecimalString | null;
  condition: GoodsCondition | null;
  partyName: string | null;
  partyIdType: string | null;
  partyIdNumber: string | null;
  note: string | null;
  createdByName: string;
}

/**
 * POST /window-desk/bookings/:id/receipt (plan 13 section 3): the window receives the goods. The
 * goods receipt body without the warehouse (always the booking's window), its storage location or
 * the status (the shipment moves to RECEIVED_ORIGIN_WAREHOUSE when the state machine allows it).
 */
export interface WindowDeskReceiptRequest {
  packages: number;
  weightKg?: DecimalString | null;
  volumeCbm?: DecimalString | null;
  condition: GoodsCondition;
  partyName?: string | null;
  partyIdType?: string | null;
  partyIdNumber?: string | null;
  note?: string | null;
  /** Defaults to now; may be earlier, never in the future. */
  occurredAt?: string;
  /** Confirms more packages than the cargo lines have; a note is then required. */
  extraPackagesConfirmed?: boolean;
}

/** A customer's payment taken at the window: a posted receipt into the window's cash account. */
export interface WindowDeskPaymentDto {
  id: string;
  number: string;
  receiptDate: string;
  currency: CurrencyCode;
  amount: DecimalString;
  reference: string | null;
  createdByName: string;
  /** The invoices it paid, as their printout lists them. */
  invoices: { number: string | null; amount: DecimalString }[];
}

/**
 * POST /window-desk/bookings/:id/payment (plan 13 section 4): the window takes the customer's
 * money. The server approves the booking's pro forma invoice if it is still one, then posts a
 * receipt into the window's cash account for `currency`, paying the booking's invoices in that
 * currency (main first, then additional by date); never more than they owe, never an advance.
 * `requestId` becomes the receipt's id: a retry with the same content returns it.
 */
export interface WindowDeskPaymentRequest {
  requestId: string;
  amount: DecimalString;
  currency: CurrencyCode;
  reference?: string | null;
}

/** GET /warehouses/:id/cash-accounts: a window's cash account for one currency. */
export interface WindowCashAccountDto {
  currency: CurrencyCode;
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  accountNameEn: string;
}

/** PUT /warehouses/:id/cash-accounts/:currency (accounts:update). */
export interface WindowCashAccountRequest {
  accountId: string;
}
