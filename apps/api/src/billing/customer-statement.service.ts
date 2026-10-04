import { BadRequestException, Injectable } from '@nestjs/common';
import type { CustomerStatementDto } from '@nolon/shared';
import { LedgerReportsService } from '../accounting/ledger-reports.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { reportBranchIds } from '../auth/branch-scope.js';
import { CustomersService } from '../customers/customers.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { buildStatementSections, statementKind } from './statement.js';

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
 * reversing entry.
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
    const idsOf = (source: 'CUSTOMER_INVOICE' | 'RECEIPT') => [
      ...new Set(
        movements
          .map(documentOf)
          .filter((d) => d.source === source && d.id !== null)
          .map((d) => d.id as string),
      ),
    ];
    const [invoices, receipts] = await Promise.all([
      this.prisma.customerInvoice.findMany({
        where: { ...inBranches, id: { in: idsOf('CUSTOMER_INVOICE') }, customerId: customer.id },
        select: { id: true, number: true },
      }),
      this.prisma.receipt.findMany({
        where: { ...inBranches, id: { in: idsOf('RECEIPT') }, customerId: customer.id },
        select: { id: true, number: true },
      }),
    ]);
    const numbers = new Map<string, string | null>([
      ...invoices.map((i): [string, string | null] => [i.id, i.number]),
      ...receipts.map((r): [string, string | null] => [r.id, r.number]),
    ]);

    const sections = buildStatementSections(
      opening,
      movements.map((m) => {
        const document = documentOf(m);
        const known = document.id !== null && numbers.has(document.id);
        return {
          entryId: m.entryId,
          number: m.number,
          entryDate: m.entryDate,
          kind: statementKind(m.source, m.reversedSource),
          documentId: known ? document.id : null,
          documentNumber: known && document.id !== null ? (numbers.get(document.id) ?? null) : null,
          description: m.description,
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
