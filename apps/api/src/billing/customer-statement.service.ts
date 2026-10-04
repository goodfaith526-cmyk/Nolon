import { BadRequestException, Injectable } from '@nestjs/common';
import type { CustomerStatementDto, JournalSource } from '@nolon/shared';
import { LedgerReportsService } from '../accounting/ledger-reports.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { CustomersService } from '../customers/customers.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { buildStatementSections, statementKind } from './statement.js';

/** What a statement says of an entry whose details the user may not see. */
export const HIDDEN_ENTRY_DESCRIPTION = 'Accounting entry';

export interface StatementQuery {
  customerId: string;
  from: string;
  to: string;
  branchId?: string;
}

/**
 * Customer statement of account (annex D printout 12): the posted lines on the customer's
 * receivable and advance accounts from the ledger, as of `to`, with the opening balance before
 * `from` and a running balance, per currency, in the user's branches (or the one requested).
 * Drafts never count; a cancelled receipt shows as the receipt and, on its own date, its
 * reversing entry. Credit notes and opening items show with their own kind and number.
 */
@Injectable()
export class CustomerStatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerReportsService,
    private readonly customers: CustomersService,
  ) {}

  async statement(user: AuthUser, q: StatementQuery): Promise<CustomerStatementDto> {
    if (q.from > q.to) throw new BadRequestException('from must not be after to');
    // 403 for a branch outside the user's, then 404 for a customer outside them.
    const branchIds = reportBranchIds(user, q.branchId);
    const inBranches = { branchId: { in: branchIds } };
    const customer = await this.customers.requireCustomer(user, q.customerId);
    const invoiceAccounts = await this.prisma.customerInvoice.findMany({
      where: { ...inBranches, customerId: customer.id, receivableAccountId: { not: null } },
      distinct: ['receivableAccountId'],
      select: { receivableAccountId: true },
    });
    const { opening, movements } = await this.ledger.customerAccountLines(user, {
      customerId: customer.id,
      receivableAccountIds: invoiceAccounts
        .map((i) => i.receivableAccountId)
        .filter((id): id is string => id !== null),
      from: q.from,
      to: q.to,
      branchId: q.branchId,
    });

    const documentOf = (m: (typeof movements)[number]) =>
      m.source === 'REVERSAL'
        ? { source: m.reversedSource, id: m.reversedSourceId }
        : { source: m.source, id: m.sourceId };
    const idsOf = (...sources: JournalSource[]) => [
      ...new Set(
        movements
          .map(documentOf)
          .filter((d) => d.source !== null && sources.includes(d.source) && d.id !== null)
          .map((d) => d.id as string),
      ),
    ];
    // An opening item (rule 15) is an invoice: its entry's source id is the invoice's id.
    const [invoices, openingItems, receipts, creditNotes] = await Promise.all([
      this.prisma.customerInvoice.findMany({
        where: { ...inBranches, id: { in: idsOf('CUSTOMER_INVOICE') }, customerId: customer.id },
        select: { id: true, number: true },
      }),
      this.prisma.customerInvoice.findMany({
        where: {
          ...inBranches,
          id: { in: idsOf('OPENING_BALANCE') },
          customerId: customer.id,
          isOpening: true,
        },
        select: { id: true, number: true },
      }),
      this.prisma.receipt.findMany({
        where: { ...inBranches, id: { in: idsOf('RECEIPT') }, customerId: customer.id },
        select: { id: true, number: true },
      }),
      this.prisma.creditNote.findMany({
        where: { ...inBranches, id: { in: idsOf('CREDIT_NOTE') }, customerId: customer.id },
        select: { id: true, number: true },
      }),
    ]);
    const numbers = new Map<string, string | null>(
      [...invoices, ...openingItems, ...receipts, ...creditNotes].map(
        (d): [string, string | null] => [d.id, d.number],
      ),
    );

    // An entry with no invoice, receipt, credit note or opening item behind it (a manual entry, or
    // its reversal) is only shown in full to users who may view journal entries: its text and
    // number are theirs.
    const seesJournals = user.permissions.has('manual_journals:view');
    const sections = buildStatementSections(
      opening,
      movements.map((m) => {
        const document = documentOf(m);
        const known = document.id !== null && numbers.has(document.id);
        const hidden = !known && !seesJournals;
        return {
          entryId: hidden ? null : m.entryId,
          number: hidden ? null : m.number,
          entryDate: m.entryDate,
          kind: statementKind(m.source, m.reversedSource),
          documentId: known ? document.id : null,
          documentNumber: known && document.id !== null ? (numbers.get(document.id) ?? null) : null,
          description: hidden ? HIDDEN_ENTRY_DESCRIPTION : m.description,
          detailsHidden: hidden,
          currency: m.currency,
          debit: m.debit,
          credit: m.credit,
          debitUsd: m.debitUsd,
          creditUsd: m.creditUsd,
        };
      }),
    );
    return {
      customerId: customer.id,
      customerNumber: customer.number,
      customerName: customer.name,
      customerBranchId: customer.branchId,
      branchId: q.branchId ?? null,
      from: q.from,
      to: q.to,
      sections,
    };
  }
}
