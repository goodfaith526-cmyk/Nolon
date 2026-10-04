import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
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
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess, branchScope } from '../auth/branch-scope.js';
import { type Decimal, dec, toDecimalStringOrNull } from '../common/money.js';
import { formatDocumentNumber, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Customer, CustomerContact, Party, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

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

  async create(user: AuthUser, input: CreateCustomerRequest): Promise<CustomerDto> {
    assertBranchAccess(user, input.branchId);
    const branch = await this.prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch?.isActive) throw new BadRequestException('Unknown or inactive branch');
    await this.checkReferences(input);
    const { branchId, ...fields } = input;
    const created = await this.prisma.$transaction(async (tx) => {
      const number = formatDocumentNumber('CUS', await nextSequenceValue(tx, 'CUSTOMER'));
      return tx.customer.create({
        data: { ...toData(fields), number, branchId, createdById: user.id },
        include: details,
      });
    });
    return toDto(created);
  }

  async update(user: AuthUser, id: string, input: Partial<CustomerInput>): Promise<CustomerDto> {
    const existing = await this.findScoped(user, id);
    const merged = {
      creditLimit: toDecimalStringOrNull(existing.creditLimit),
      creditLimitCurrency: existing.creditLimitCurrency,
      ...input,
    };
    await this.checkReferences(merged);
    const updated = await this.prisma.customer.update({
      where: { id: existing.id },
      data: toData(input),
      include: details,
    });
    return toDto(updated);
  }

  async setActive(user: AuthUser, id: string, isActive: boolean): Promise<CustomerDto> {
    const existing = await this.findScoped(user, id);
    return toDto(
      await this.prisma.customer.update({
        where: { id: existing.id },
        data: { isActive },
        include: details,
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
    if (input.preferredCurrency) await this.currencies.requireActive(input.preferredCurrency);
    const hasLimit = input.creditLimit !== undefined && input.creditLimit !== null;
    const hasLimitCurrency = Boolean(input.creditLimitCurrency);
    if (hasLimit !== hasLimitCurrency) {
      throw new BadRequestException('Credit limit and its currency go together');
    }
    if (input.creditLimitCurrency) await this.currencies.requireActive(input.creditLimitCurrency);
  }
}

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
