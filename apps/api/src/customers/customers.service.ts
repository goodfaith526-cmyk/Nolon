import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AuditChangeDto,
  ContactInput,
  CreateCustomerRequest,
  CustomerContactDto,
  CustomerDto,
  CustomerInput,
  CustomerSummaryDto,
  Page,
  PartyDto,
  PartyInput,
} from '@nolon/shared';
import { type AuditRecord, AuditService, changedFields } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { lockActiveBranches, lockBranchRule } from '../common/branch-locks.js';
import { type Decimal, dec, toDecimalStringOrNull } from '../common/money.js';
import { formatDocumentNumber, nextSequenceRange, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import {
  type RuleIssue,
  memoAsync,
  refusal,
  throwFirstConflict,
  throwFirstIssue,
} from '../common/rule-issues.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Customer, CustomerContact, Party, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Rows per INSERT of a bulk import (keeps the statement under PostgreSQL's parameter limit). */
const WRITE_CHUNK = 1000;

/** The per-branch lock every write that can change a customer's phone or tax number takes. */
export const CUSTOMER_UNIQUE_RULE = 'customer-phone-tax';

/** How tax numbers compare: case and surrounding spaces do not matter. */
export const normalizeTaxNumber = (value: string) => value.trim().toUpperCase();

/** What a customer write would claim in its branch; `excludeId` is the customer being edited. */
export interface CustomerKeys {
  branchId: string;
  phone?: string;
  taxNumber?: string | null;
  excludeId?: string;
}

const sameTaxNumber = (a: string, b: string | null) =>
  b !== null && normalizeTaxNumber(a) === normalizeTaxNumber(b);

type CustomerWithDetails = Customer & { contacts: CustomerContact[]; parties: Party[] };

/**
 * Customers, their authorized contacts and their shipper/consignee/notify address book (scope 6).
 * Customers are branch-owned: every read and write is limited to the user's branches.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currencies: CurrenciesService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, query: PageQuery): Promise<Page<CustomerSummaryDto>> {
    const where: Prisma.CustomerWhereInput = { ...branchScope(user) };
    if (query.q) {
      const q = query.q;
      where.OR = [
        { number: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
        { companyName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q.replace(/\s/g, '') } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);
    return { items: items.map(toSummary), total, page: query.page, pageSize: query.pageSize };
  }

  async get(user: AuthUser, id: string): Promise<CustomerDto> {
    return toDto(await this.findScoped(user, id));
  }

  /**
   * A phone, and a tax number when given, is unique per branch: the check runs under the branch's
   * customer lock (shared with update and the Excel import), so two writers cannot both pass it.
   * A duplicate is a 409.
   */
  async create(user: AuthUser, input: CreateCustomerRequest): Promise<CustomerDto> {
    assertBranchAccess(user, input.branchId);
    await this.checkReferences(input);
    const { branchId, ...fields } = input;
    const created = await this.prisma.$transaction(async (tx) => {
      if (!(await lockActiveBranches(tx, [branchId])).has(branchId)) {
        throw new BadRequestException('Unknown or inactive branch');
      }
      await lockBranchRule(tx, CUSTOMER_UNIQUE_RULE, [branchId]);
      throwFirstConflict(await this.duplicateIssues(tx, [input]));
      const number = formatDocumentNumber('CUS', await nextSequenceValue(tx, 'CUSTOMER'));
      const customer = await tx.customer.create({
        data: { ...toData(fields), number, branchId, createdById: user.id },
        include: details,
      });
      await this.audit.record(
        tx,
        user,
        auditRecord(customer, 'CREATED', changedFields(null, auditFields(customer), AUDIT_FIELDS)),
      );
      return customer;
    });
    return toDto(created);
  }

  /**
   * Writes the customers of an Excel import inside the caller's transaction, each with its given
   * id and the next consecutive customer numbers. The import has already checked each input's
   * schema and references; here, under the same locks as create, branch access is asserted again,
   * each branch must still be active (its row is locked, so it stays active until the import
   * commits) and no phone or tax number may already be taken in the branch.
   *
   * Returns the issues of each row, in order. When any row has one, nothing is written.
   */
  async createImported(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    rows: readonly { id: string; input: CreateCustomerRequest }[],
  ): Promise<RuleIssue[][]> {
    for (const { input } of rows) assertBranchAccess(user, input.branchId);
    if (rows.length === 0) return [];
    const branchIds = rows.map((r) => r.input.branchId);
    const active = await lockActiveBranches(tx, branchIds);
    await lockBranchRule(tx, CUSTOMER_UNIQUE_RULE, branchIds);
    const duplicates = await this.duplicateIssues(
      tx,
      rows.map((r) => r.input),
    );
    const issues = rows.map(({ input }, i): RuleIssue[] => [
      ...(active.has(input.branchId) ? [] : [inactiveBranch]),
      ...(duplicates[i] ?? []),
    ]);
    if (issues.some((list) => list.length > 0)) return issues;
    const first = await nextSequenceRange(tx, 'CUSTOMER', rows.length);
    const data = rows.map(({ id, input }, i) => {
      const { branchId, ...fields } = input;
      return {
        ...toData(fields),
        id,
        number: formatDocumentNumber('CUS', first + BigInt(i)),
        branchId,
        createdById: user.id,
      };
    });
    for (let i = 0; i < data.length; i += WRITE_CHUNK) {
      await tx.customer.createMany({ data: data.slice(i, i + WRITE_CHUNK) });
    }
    await this.audit.recordMany(
      tx,
      user,
      data.map((c) =>
        auditRecord({ id: c.id, branchId: c.branchId, number: c.number, name: c.name }, 'CREATED', [
          { field: 'source', before: null, after: 'Excel import' },
        ]),
      ),
    );
    return issues;
  }

  /**
   * For each candidate, the phone or tax number another customer of its branch already holds
   * (inactive customers included). Binding only while the caller holds the branch's customer lock
   * (create, update, import); without it (the import preview) it is advice.
   */
  async duplicateIssues(
    client: Prisma.TransactionClient,
    candidates: readonly CustomerKeys[],
  ): Promise<RuleIssue[][]> {
    const phones = [...new Set(candidates.flatMap((c) => (c.phone ? [c.phone] : [])))];
    const taxes = [...new Set(candidates.flatMap((c) => (c.taxNumber ? [c.taxNumber] : [])))];
    if (phones.length === 0 && taxes.length === 0) return candidates.map(() => []);
    const existing = await client.customer.findMany({
      where: {
        branchId: { in: [...new Set(candidates.map((c) => c.branchId))] },
        OR: [
          ...(phones.length > 0 ? [{ phone: { in: phones } }] : []),
          ...(taxes.length > 0 ? [{ taxNumber: { in: taxes, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: { id: true, branchId: true, number: true, phone: true, taxNumber: true },
    });
    const holder = (excludeId: string | undefined, matches: (c: (typeof existing)[0]) => boolean) =>
      existing.find((c) => c.id !== excludeId && matches(c))?.number;
    return candidates.map(({ branchId, phone, taxNumber, excludeId }) => {
      const issues: RuleIssue[] = [];
      const samePhone =
        phone && holder(excludeId, (c) => c.branchId === branchId && c.phone === phone);
      if (samePhone) {
        issues.push({
          field: 'phone',
          code: 'DUPLICATE_IN_DB',
          message: `Customer ${samePhone} of this branch has this phone`,
        });
      }
      const sameTax =
        taxNumber &&
        holder(excludeId, (c) => c.branchId === branchId && sameTaxNumber(taxNumber, c.taxNumber));
      if (sameTax) {
        issues.push({
          field: 'taxNumber',
          code: 'DUPLICATE_IN_DB',
          message: `Customer ${sameTax} of this branch has this tax number`,
        });
      }
      return issues;
    });
  }

  /**
   * The phone and tax number are checked against the customer as it is now, not as it was read
   * before the transaction: the row is locked and read again first, so a stale form cannot put
   * back a phone or tax number the customer gave up and another customer took meanwhile.
   *
   * Lock order: the customer row (FOR NO KEY UPDATE), then the branch's customer rule lock. Create
   * and import take the rule lock and only insert new rows, so no path takes the rule lock and
   * then this row: the two orders cannot deadlock.
   */
  async update(user: AuthUser, id: string, input: Partial<CustomerInput>): Promise<CustomerDto> {
    const read = await this.findScoped(user, id);
    const withLimit = (c: Customer) => ({
      creditLimit: toDecimalStringOrNull(c.creditLimit),
      creditLimitCurrency: c.creditLimitCurrency,
      ...input,
    });
    await this.checkReferences(withLimit(read));
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "customers" WHERE "id" = ${read.id}::uuid FOR NO KEY UPDATE`;
      const current = await tx.customer.findFirst({ where: { id: read.id, ...branchScope(user) } });
      if (!current) throw new NotFoundException('Customer not found');
      if (
        current.creditLimit?.toString() !== read.creditLimit?.toString() ||
        current.creditLimitCurrency !== read.creditLimitCurrency
      ) {
        await this.checkReferences(withLimit(current));
      }
      // A phone or tax number the customer does not hold now must be free in the branch (409),
      // checked under the lock.
      const keys: CustomerKeys = {
        branchId: current.branchId,
        excludeId: current.id,
        ...(input.phone !== undefined && input.phone !== current.phone
          ? { phone: input.phone }
          : {}),
        ...(input.taxNumber && !sameTaxNumber(input.taxNumber, current.taxNumber)
          ? { taxNumber: input.taxNumber }
          : {}),
      };
      if (keys.phone !== undefined || keys.taxNumber) {
        await lockBranchRule(tx, CUSTOMER_UNIQUE_RULE, [current.branchId]);
        throwFirstConflict(await this.duplicateIssues(tx, [keys]));
      }
      const changed = await tx.customer.update({
        where: { id: current.id },
        data: toData(input),
        include: details,
      });
      await this.audit.record(
        tx,
        user,
        auditRecord(
          changed,
          'UPDATED',
          changedFields(auditFields(current), auditFields(changed), AUDIT_FIELDS),
        ),
      );
      return changed;
    });
    return toDto(updated);
  }

  async setActive(user: AuthUser, id: string, isActive: boolean): Promise<CustomerDto> {
    const existing = await this.findScoped(user, id);
    return toDto(
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.customer.findUniqueOrThrow({ where: { id: existing.id } });
        const changed = await tx.customer.update({
          where: { id: existing.id },
          data: { isActive },
          include: details,
        });
        await this.audit.record(
          tx,
          user,
          auditRecord(
            changed,
            'UPDATED',
            changedFields({ isActive: before.isActive }, { isActive }, ['isActive']),
          ),
        );
        return changed;
      }),
    );
  }

  async addContact(user: AuthUser, customerId: string, input: ContactInput): Promise<CustomerDto> {
    const customer = await this.findScoped(user, customerId);
    await this.writeContacts(customer.id, async (tx) => {
      if (input.isPrimary) {
        await tx.customerContact.updateMany({
          where: { customerId: customer.id },
          data: { isPrimary: false },
        });
      }
      await tx.customerContact.create({ data: { ...input, customerId: customer.id } });
    });
    return this.get(user, customer.id);
  }

  async updateContact(
    user: AuthUser,
    customerId: string,
    contactId: string,
    input: Partial<ContactInput>,
  ): Promise<CustomerDto> {
    const customer = await this.findScoped(user, customerId);
    if (!customer.contacts.some((c) => c.id === contactId)) {
      throw new NotFoundException('Contact not found');
    }
    await this.writeContacts(customer.id, async (tx) => {
      if (input.isPrimary) {
        await tx.customerContact.updateMany({
          where: { customerId: customer.id, id: { not: contactId } },
          data: { isPrimary: false },
        });
      }
      await tx.customerContact.update({ where: { id: contactId }, data: input });
    });
    return this.get(user, customer.id);
  }

  /**
   * Contact changes of one customer run one at a time (customer row lock), so moving the primary
   * flag is never interleaved. A unique partial index backs the one-primary rule in the database.
   */
  private async writeContacts(
    customerId: string,
    write: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "customers" WHERE "id" = ${customerId}::uuid FOR UPDATE`;
        await write(tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A customer has only one primary contact');
      }
      throw error;
    }
  }

  async addParty(user: AuthUser, customerId: string, input: PartyInput): Promise<CustomerDto> {
    const customer = await this.findScoped(user, customerId);
    await this.prisma.party.create({ data: { ...input, customerId: customer.id } });
    return this.get(user, customer.id);
  }

  async updateParty(
    user: AuthUser,
    customerId: string,
    partyId: string,
    input: Partial<PartyInput>,
  ): Promise<CustomerDto> {
    const customer = await this.findScoped(user, customerId);
    if (!customer.parties.some((p) => p.id === partyId)) {
      throw new NotFoundException('Party not found');
    }
    await this.prisma.party.update({ where: { id: partyId }, data: input });
    return this.get(user, customer.id);
  }

  /**
   * For quotations and bookings: the customer must be in the user's branches (404 otherwise, so
   * other branches' customers are not revealed) and active (400).
   */
  /** For other modules: 404 unless the customer is in one of the user's branches. */
  async requireCustomer(user: AuthUser, id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({ where: { id, ...branchScope(user) } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async requireActiveCustomer(user: AuthUser, id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({ where: { id, ...branchScope(user) } });
    if (!customer) throw new NotFoundException('Customer not found');
    if (!customer.isActive) throw new BadRequestException('Customer is inactive');
    return customer;
  }

  /** 400 unless every given party belongs to this customer. */
  async requireOwnParties(customerId: string, partyIds: (string | null | undefined)[]) {
    const ids = [...new Set(partyIds.filter((p): p is string => typeof p === 'string'))];
    if (ids.length === 0) return;
    const found = await this.prisma.party.count({ where: { id: { in: ids }, customerId } });
    if (found !== ids.length) {
      throw new BadRequestException('Shipper, consignee and notify party must be the customer’s');
    }
  }

  private async findScoped(user: AuthUser, id: string): Promise<CustomerWithDetails> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, ...branchScope(user) },
      include: details,
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  private async checkReferences(input: Partial<CustomerInput>): Promise<void> {
    throwFirstIssue(await this.referenceChecker()(input));
  }

  /**
   * The rules a customer's references must meet (scope 6), as issues by field: create and update
   * throw the first, the Excel import reports them all. Lookups are cached per checker, so a file
   * of thousands of rows asks for each currency once.
   */
  referenceChecker(): (input: Partial<CustomerInput>) => Promise<RuleIssue[]> {
    const currencyRefusal = memoAsync((code: string) =>
      refusal(() => this.currencies.requireActive(code)),
    );
    return async (input) => {
      const issues: RuleIssue[] = [];
      if (input.preferredCurrency) {
        const refused = await currencyRefusal(input.preferredCurrency);
        if (refused) {
          issues.push({ field: 'preferredCurrency', code: 'UNKNOWN_CURRENCY', message: refused });
        }
      }
      const hasLimit = input.creditLimit !== undefined && input.creditLimit !== null;
      const hasLimitCurrency = Boolean(input.creditLimitCurrency);
      if (hasLimit !== hasLimitCurrency) {
        issues.push({
          field: hasLimit ? 'creditLimitCurrency' : 'creditLimit',
          code: 'CREDIT_LIMIT_PAIR',
          message: 'Credit limit and its currency go together',
        });
      }
      if (input.creditLimitCurrency) {
        const refused = await currencyRefusal(input.creditLimitCurrency);
        if (refused) {
          issues.push({ field: 'creditLimitCurrency', code: 'UNKNOWN_CURRENCY', message: refused });
        }
      }
      return issues;
    };
  }
}

const inactiveBranch: RuleIssue = {
  field: 'branchId',
  code: 'BRANCH_NOT_ALLOWED',
  message: 'Not one of your active branches',
};

const details = {
  contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
  parties: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.CustomerInclude;

function toData<T extends Partial<CustomerInput>>(
  input: T,
): Omit<T, 'creditLimit'> & { creditLimit?: Decimal | null } {
  const { creditLimit, ...rest } = input;
  if (creditLimit === undefined) return rest;
  return { ...rest, creditLimit: creditLimit === null ? null : dec(creditLimit) };
}

function toSummary(c: Customer): CustomerSummaryDto {
  return {
    id: c.id,
    number: c.number,
    branchId: c.branchId,
    kind: c.kind,
    name: c.name,
    companyName: c.companyName,
    phone: c.phone,
    isActive: c.isActive,
  };
}

function toContactDto(c: CustomerContact): CustomerContactDto {
  return {
    id: c.id,
    name: c.name,
    position: c.position,
    phone: c.phone,
    email: c.email,
    idNumber: c.idNumber,
    canInquire: c.canInquire,
    canReceiveCargo: c.canReceiveCargo,
    canReceiveDocuments: c.canReceiveDocuments,
    isPrimary: c.isPrimary,
    isActive: c.isActive,
  };
}

function toPartyDto(p: Party): PartyDto {
  return {
    id: p.id,
    name: p.name,
    companyName: p.companyName,
    phone: p.phone,
    email: p.email,
    countryCode: p.countryCode,
    city: p.city,
    address: p.address,
  };
}

/** The fields of a customer the audit log compares. */
const AUDIT_FIELDS = [
  'kind',
  'name',
  'companyName',
  'phone',
  'whatsapp',
  'email',
  'countryCode',
  'city',
  'address',
  'taxNumber',
  'preferredCurrency',
  'preferredLocale',
  'paymentTermsDays',
  'creditLimit',
  'creditLimitCurrency',
  'notes',
  'isActive',
] as const;

function auditFields(c: Customer): Pick<Customer, (typeof AUDIT_FIELDS)[number]> {
  const fields = {} as Record<(typeof AUDIT_FIELDS)[number], unknown>;
  for (const f of AUDIT_FIELDS) fields[f] = c[f];
  return fields as Pick<Customer, (typeof AUDIT_FIELDS)[number]>;
}

/** A customer change for the audit log, named by number and name. */
function auditRecord(
  c: { id: string; branchId: string; number: string; name: string },
  action: 'CREATED' | 'UPDATED',
  changes: AuditChangeDto[],
): AuditRecord {
  return {
    branchId: c.branchId,
    entity: 'CUSTOMER',
    entityId: c.id,
    reference: `${c.number} ${c.name}`,
    action,
    changes,
  };
}

function toDto(c: CustomerWithDetails): CustomerDto {
  return {
    ...toSummary(c),
    whatsapp: c.whatsapp,
    email: c.email,
    countryCode: c.countryCode,
    city: c.city,
    address: c.address,
    taxNumber: c.taxNumber,
    preferredCurrency: c.preferredCurrency,
    preferredLocale: c.preferredLocale === 'en' ? 'en' : 'ar',
    paymentTermsDays: c.paymentTermsDays,
    creditLimit: toDecimalStringOrNull(c.creditLimit),
    creditLimitCurrency: c.creditLimitCurrency,
    notes: c.notes,
    createdAt: c.createdAt.toISOString(),
    contacts: c.contacts.map(toContactDto),
    parties: c.parties.map(toPartyDto),
  };
}
