import type { FxRateString } from './accounting.js';
import type { CurrencyCode, DecimalString } from './currencies.js';

/**
 * General expenses (scope 13, annex C rule 12): an expense not tied to a shipment, paid from a cash
 * or bank account, by category. Categories are master data the client extends; each posts to an
 * expense account.
 */

export interface ExpenseCategoryDto {
  code: string;
  nameEn: string;
  nameAr: string;
  accountId: string;
  isActive: boolean;
}

export interface ExpenseCategoryInput {
  code: string;
  nameEn: string;
  nameAr: string;
  accountId: string;
  isActive?: boolean;
}

export const EXPENSE_STATUSES = ['DRAFT', 'APPROVED', 'CANCELLED'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export interface ExpenseSummaryDto {
  id: string;
  number: string | null;
  branchId: string;
  expenseDate: string;
  categoryCode: string;
  description: string;
  currency: CurrencyCode;
  amount: DecimalString;
  status: ExpenseStatus;
}

export interface ExpenseDto extends ExpenseSummaryDto {
  fxRate: FxRateString;
  cashAccountId: string;
  cashAccountCode: string;
  cashAccountNameEn: string;
  cashAccountNameAr: string;
  reference: string | null;
  journalEntryId: string | null;
  journalEntryNumber: string | null;
  cancelJournalEntryId: string | null;
  cancelJournalEntryNumber: string | null;
  approvedAt: string | null;
  cancelReason: string | null;
  actions: { canEdit: boolean; canApprove: boolean; canCancel: boolean };
}

export interface ExpenseInput {
  expenseDate: string;
  categoryCode: string;
  description: string;
  currency: CurrencyCode;
  /** Omitted: the rate table's rate for the expense date. Ignored for USD. */
  fxRate?: FxRateString | null;
  amount: DecimalString;
  cashAccountId: string;
  reference?: string | null;
}

export interface CreateExpenseRequest extends ExpenseInput {
  /** Client-generated UUID: a retry of the same request returns the first draft. */
  requestId: string;
  branchId: string;
}
