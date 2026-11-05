import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AuditChangeDto,
  CsInstantAccountOutcome,
  ContactInput,
  CreateCustomerRequest,
  CustomerContactDto,
  CustomerDto,
  CustomerPartyAddedDto,
  CustomerInput,
  CustomerKind,
  CustomerSummaryDto,
  Page,
  PartyDto,
  PartyInput,
} from '@nolon/shared';
import {
  type AuditRecord,
  AuditService,
  type AuditValue,
  changedFields,
} from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertBranchAccess } from '../auth/branch-scope.js';
import {
  lockRecordOutletInTx,
  customerOutletScope,
  outletForWriteInTx,
  outletLimited,
} from '../auth/outlet-scope.js';
import { lockActiveBranches, lockBranchRule } from '../common/branch-locks.js';
import { type Decimal, dec, toDecimalStringOrNull } from '../common/money.js';
import { formatShortNumber, nextSequenceRange, nextSequenceValue } from '../common/numbering.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import {
  type RuleIssue,
  memoAsync,
  onFields,
  refusal,
  throwFirstConflict,
  throwFirstIssue,
} from '../common/rule-issues.js';
import type { PageQuery } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Customer, CustomerContact, Party, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import {
  PartnerRefsService,
  partnerRefSelect,
  toPartnerRef,
} from '../partners/partner-refs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Rows per INSERT of a bulk import (keeps the statement under PostgreSQL's parameter limit). */
const WRITE_CHUNK = 1000;

/** Only the internal profile account path may omit a phone; legacy HTTP forms stay unchanged. */
type CustomerWriteFields = Omit<CustomerInput, 'phone'> & { phone: string | null };

/** The per-branch lock every write that can change a customer's phone or tax number takes. */
export const CUSTOMER_UNIQUE_RULE = 'customer-phone-tax';

/** Codex F200-2: the lock a bot approval takes before it finds or makes a customer's party. */
const CUSTOMER_PARTIES_RULE = 'customer-approval-parties';

/**
 * Plan 09d: the lock every write that can change a customer's phone or tax number takes. One for
 * the company, since both are unique across all branches.
 */
export const lockCustomerKeys = (tx: Prisma.TransactionClient) =>
  lockBranchRule(tx, CUSTOMER_UNIQUE_RULE, ['company']);

/**
 * Plan 09d (owner, 2026-11-04): a customer is tied to no branch. Every user who may see
 * customers sees all of them; Outlet Staff only their outlets' customers of their branches.
 */
/**
 * Plan 09d: one account per profile. Where older data holds several, the profile's account is the
 * oldest active one (then the oldest inactive one): a stable choice, the others stay as they are.
 */
const PROFILE_ACCOUNT_ORDER: Prisma.CustomerOrderByWithRelationInput[] = [
  { isActive: 'desc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

/** Plan 09d: credit limits are financial, read with customer_invoices:view in any branch. */
function seesCredit(user: AuthUser): boolean {
  return user.access.branchesWith(['customer_invoices:view']).length > 0;
}

/**
 * Plan 09d: the credit limit is read and written only by holders of customer_invoices:view in any
 * branch, the customer's financial data: a user who cannot see the limit cannot overwrite it. For
 * the others an empty limit (what their masked form sends back) leaves the stored one as it is,
 * and any other value is a 403.
 */
function creditInput<
  T extends { creditLimit?: CustomerInput['creditLimit']; creditLimitCurrency?: string | null },
>(
  user: AuthUser,
  input: T,
  current: Pick<Customer, 'creditLimit' | 'creditLimitCurrency'> | null,
): T {
  if (seesCredit(user)) return input;
  const { creditLimit, creditLimitCurrency, ...rest } = input;
  const given = (creditLimit ?? null) !== null || (creditLimitCurrency ?? null) !== null;
  if (!given) return rest as T;
  const same =
    current !== null &&
    current.creditLimit !== null &&
    creditLimit !== undefined &&
    creditLimit !== null &&
    dec(creditLimit).equals(current.creditLimit) &&
    creditLimitCurrency === current.creditLimitCurrency;
  if (same) return rest as T;
  throw new ForbiddenException({
    code: 'CREDIT_LIMIT_FORBIDDEN',
    message: 'Setting a credit limit needs the customer invoices permission',
  });
}

function maskCredit(user: AuthUser, dto: CustomerDto): CustomerDto {
  return seesCredit(user) ? dto : { ...dto, creditLimit: null, creditLimitCurrency: null };
}

/** The user's branches where they may add customers. */
function createBranches(user: AuthUser): string[] {
  return user.access
    .branchesWith(['customers:create'])
    .filter((id) => user.allowedBranchIds.includes(id));
}

/**
 * Plan 09f: the branch a customer write acts in, for the permission check and an Outlet Staff
 * member's outlet only; the customer itself is of no branch, so no one is asked for it (owner,
 * 2026-11-04). The branch given (one of the user's), else the first of the user's branches that
 * add customers, else 403.
 */
function actingBranch(user: AuthUser, given: string | null | undefined): string {
  if (given) {
    assertBranchAccess(user, given);
    return given;
  }
  const first = createBranches(user)[0];
  if (!first) throw new ForbiddenException('You may not add customers');
  return first;
}

export function customerScope(user: AuthUser): Prisma.CustomerWhereInput {
  return outletLimited(user) ? customerOutletScope(user) : {};
}

/** How tax numbers compare: case and surrounding spaces do not matter. */
export const normalizeTaxNumber = (value: string) => value.trim().toUpperCase();

export interface CustomerFilters extends PageQuery {
  kind?: CustomerKind;
  isActive?: boolean;
}

/** What a customer write would claim company-wide; `excludeId` is the customer being edited. */
export interface CustomerKeys {
  phone?: string | null;
  taxNumber?: string | null;
  excludeId?: string;
}

const sameTaxNumber = (a: string, b: string | null) =>
  b !== null && normalizeTaxNumber(a) === normalizeTaxNumber(b);

export type CustomerWithDetails = Customer & {
  contacts: CustomerContact[];
  parties: Party[];
  acquiredViaOutlet: { id: string; number: string; name: string; isActive: boolean } | null;
};

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
    private readonly masterData: MasterDataService,
    private readonly partnerRefs: PartnerRefsService,
  ) {}

  /** Minimum legacy identity candidates, never balances or branch documents. Internal API only. */
  async profilePhoneOwnersInTx(
    tx: Prisma.TransactionClient,
    value: string,
    exceptProfile?: string,
  ): Promise<{ profileId: string | null }[]> {
    return tx.$queryRaw<
      { profileId: string | null }[]
    >`SELECT profile_id AS "profileId" FROM customers
      WHERE (profile_id IS NULL OR profile_id IS DISTINCT FROM ${exceptProfile ?? null}::uuid)
      AND (regexp_replace(phone, '[^0-9]', '', 'g') = ${value.slice(1)}
        OR regexp_replace(whatsapp, '[^0-9]', '', 'g') = ${value.slice(1)})`;
  }

  async profileLinkCandidateInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    accountId: string,
    lock = false,
  ) {
    if (lock) await tx.$queryRaw`SELECT id FROM customers WHERE id = ${accountId}::uuid FOR UPDATE`;
    const row = await tx.customer.findFirst({
      where: { id: accountId, ...customerScope(user) },
      select: {
        id: true,
        number: true,
        profileId: true,
        name: true,
        phone: true,
        address: true,
        isActive: true,
      },
    });
    if (!row || !user.access.any('customers:update'))
      throw new NotFoundException('Customer not found');
    if (!row.isActive) throw new ConflictException('Customer is inactive');
    return row;
  }

  async linkProfileInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    accountId: string,
    profileId: string,
  ): Promise<void> {
    const account = await this.profileLinkCandidateInTx(tx, user, accountId, true);
    if (account.profileId === profileId) return;
    if (account.profileId)
      throw new ConflictException('Existing profiles need a separate merge review');
    await tx.customer.update({ where: { id: accountId }, data: { profileId } });
    await this.audit.record(tx, user, {
      branchId: null,
      entity: 'CUSTOMER',
      entityId: accountId,
      reference: account.number,
      action: 'UPDATED',
      changes: [{ field: 'profileId', before: null, after: profileId }],
    });
  }

  /** Internal branch-account materialisation for an explicitly linked unified profile. */
  async profileAccountInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    profile: { id: string; name: string | null; phone: string | null; phoneVerified: boolean },
    branchId: string,
  ): Promise<string> {
    assertBranchAccess(user, branchId);
    if (outletLimited(user)) throw new NotFoundException('Customer not found');
    // Plan 09d: one account per profile, in whichever branch it was made.
    const existing = await tx.customer.findFirst({
      where: { profileId: profile.id },
      orderBy: PROFILE_ACCOUNT_ORDER,
    });
    if (existing) {
      await this.lockActiveCustomerInTx(tx, existing.id);
      return existing.id;
    }
    if (!user.access.has('customers:create', branchId))
      throw new NotFoundException('Customer creation is not allowed');
    if (!profile.name)
      throw new BadRequestException({
        code: 'PROFILE_NAME_REQUIRED',
        message: 'Complete the explicit customer name before approval',
        fields: ['profile.name'],
      });
    const account = await this.createInTx(tx, user, {
      branchId,
      kind: 'INDIVIDUAL',
      name: profile.name,
      phone: profile.phoneVerified ? profile.phone : null,
    });
    await tx.customer.update({ where: { id: account.id }, data: { profileId: profile.id } });
    return account.id;
  }

  /**
   * The customer of an approved bot request linked to no one (the website chat; client request
   * 2026-11-04): made in the request's branch from the sender name and contact phone the bot sent,
   * inside the approval's transaction, with the ordinary create checks. Never matched to an existing
   * customer by phone or name: a phone another customer of the branch has is a 409, and staff
   * choose that customer instead.
   */
  async requestAccountInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    input: { branchId: string; name: string; phone: string | null; apiClientId: string },
  ): Promise<string> {
    assertBranchAccess(user, input.branchId);
    if (!user.access.has('customers:create', input.branchId))
      throw new ForbiddenException({
        code: 'CUSTOMER_CREATE_FORBIDDEN',
        message: 'You may not add customers in this branch: choose an existing one',
      });
    const name = input.name.trim();
    if (!name)
      throw new BadRequestException({
        code: 'SENDER_NAME_REQUIRED',
        message: 'The request has no sender name: choose the customer',
      });
    const account = await this.createInTx(tx, user, {
      branchId: input.branchId,
      kind: 'INDIVIDUAL',
      name,
      phone: input.phone,
    });
    await tx.customer.update({
      where: { id: account.id },
      data: { createdViaApiClientId: input.apiClientId },
    });
    return account.id;
  }

  /**
   * The owner's instant account (2026-11-03): the branch account of a unified profile, made or
   * reused when a signed bot request is saved, inside its transaction. The caller has checked the
   * signed binding and locked the profile. The checks of approval apply, but a profile that is not
   * ready gives a reason for staff instead of a refusal, so the request is still saved: a stale
   * profile version, identity proposals to review, no explicit name, a verified phone another
   * account of the branch already has (never merged by phone or name), an inactive account. An
   * unverified phone is never copied; the account is an individual with no credit or terms. The
   * audit record names the key, never the customer's name or phone.
   */
  async botAccountInTx(
    tx: Prisma.TransactionClient,
    input: {
      profile: {
        id: string;
        version: number;
        needsReview: boolean;
        name: string | null;
        phone: string | null;
        phoneVerified: boolean;
      };
      expectedVersion: number | undefined;
      apiClientId: string;
    },
  ): Promise<{ outcome: CsInstantAccountOutcome; customerId: string | null }> {
    const { profile } = input;
    const skip = (outcome: CsInstantAccountOutcome) => ({ outcome, customerId: null });
    if (input.expectedVersion !== undefined && input.expectedVersion !== profile.version)
      return skip('PROFILE_CHANGED');
    if (profile.needsReview) return skip('PROFILE_REVIEW');
    // Plan 09d: one account per profile, in whichever branch it was made.
    const existing = await tx.customer.findFirst({
      where: { profileId: profile.id },
      orderBy: PROFILE_ACCOUNT_ORDER,
      select: { id: true },
    });
    if (existing) {
      const rows = await tx.$queryRaw<{ isActive: boolean }[]>`
        SELECT "is_active" AS "isActive" FROM "customers" WHERE "id" = ${existing.id}::uuid FOR SHARE`;
      return rows[0]?.isActive
        ? { outcome: 'REUSED', customerId: existing.id }
        : skip('ACCOUNT_INACTIVE');
    }
    const name = profile.name?.trim();
    if (!name) return skip('NAME_MISSING');
    const phone = profile.phoneVerified ? profile.phone : null;
    await lockCustomerKeys(tx);
    if (phone && (await tx.customer.count({ where: { phone } })) > 0) return skip('PHONE_IN_USE');
    const number = formatShortNumber('CS', await nextSequenceValue(tx, 'CUSTOMER'));
    const customer = await tx.customer.create({
      data: {
        number,
        kind: 'INDIVIDUAL',
        name,
        phone,
        profileId: profile.id,
        createdViaApiClientId: input.apiClientId,
      },
    });
    await this.audit.recordApi(tx, {
      branchId: null,
      entity: 'CUSTOMER',
      entityId: customer.id,
      reference: customer.number,
      action: 'CREATED',
      changes: [
        { field: 'kind', before: null, after: 'INDIVIDUAL' },
        { field: 'profileId', before: null, after: profile.id },
        { field: 'createdViaApiClientId', before: null, after: input.apiClientId },
        { field: 'phoneCopied', before: null, after: phone === null ? 'no' : 'yes' },
      ],
    });
    return { outcome: 'CREATED', customerId: customer.id };
  }

  /**
   * Plan 09e: the customer holding `phone`, row share-locked. Codex F191-2: two or more
   * customers with it (rows from before phones were unique) are AMBIGUOUS, and none is chosen.
   * Codex F191-3: the row is locked before any customer-key lock, the order `update` takes
   * (row, then keys), and read again under the lock; a phone changed meanwhile is a 409 to retry.
   */
  async phoneMatchInTx(
    tx: Prisma.TransactionClient,
    phone: string,
  ): Promise<
    | { kind: 'NONE' }
    | { kind: 'AMBIGUOUS' }
    | { kind: 'ONE'; customerId: string; isActive: boolean }
  > {
    const found = await tx.customer.findMany({
      where: { phone },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    if (found.length === 0) return { kind: 'NONE' };
    if (found.length > 1) return { kind: 'AMBIGUOUS' };
    const id = found[0]!.id;
    const [row] = await tx.$queryRaw<{ phone: string | null; isActive: boolean }[]>`
      SELECT "phone", "is_active" AS "isActive" FROM "customers" WHERE "id" = ${id}::uuid FOR SHARE`;
    if (row?.phone !== phone) throw phoneChanged();
    return { kind: 'ONE', customerId: id, isActive: row.isActive };
  }

  /**
   * Plan 09e: a new individual for a person someone else named, its phone marked unverified (it
   * grants no customer token until staff confirm it, F191-1). Under the customer-key lock, taken
   * last: a customer saved with the phone meanwhile is a 409 to retry, never a lock taken on it.
   */
  async phoneCustomerCreateInTx(
    tx: Prisma.TransactionClient,
    input: { name: string; phone: string | null } & (
      { apiClientId: string; user?: undefined } | { user: AuthUser; apiClientId?: undefined }
    ),
  ): Promise<string> {
    await lockCustomerKeys(tx);
    if (input.phone !== null && (await tx.customer.count({ where: { phone: input.phone } })) > 0)
      throw phoneChanged();
    const number = formatShortNumber('CS', await nextSequenceValue(tx, 'CUSTOMER'));
    const customer = await tx.customer.create({
      data: {
        number,
        kind: 'INDIVIDUAL',
        name: input.name.trim().slice(0, 200),
        phone: input.phone,
        phoneUnverified: input.phone !== null,
        ...(input.user
          ? { createdById: input.user.id }
          : { createdViaApiClientId: input.apiClientId }),
      },
    });
    const record = {
      branchId: null,
      entity: 'CUSTOMER' as const,
      entityId: customer.id,
      reference: customer.number,
      action: 'CREATED' as const,
      changes: [
        { field: 'kind', before: null, after: 'INDIVIDUAL' },
        { field: 'phoneUnverified', before: null, after: String(input.phone !== null) },
      ],
    };
    if (input.user) await this.audit.record(tx, input.user, record);
    else await this.audit.recordApi(tx, record);
    return customer.id;
  }

  /**
   * Owner, 2026-11-05: a sender's customer that has no phone yet takes the international phone a
   * later bot request brings, marked unverified (it grants no customer token until staff confirm
   * it). A phone already set is never replaced, and a phone another customer holds is not taken.
   * Under the customer-key lock, then the row lock: the order customer edits take.
   */
  async addMissingPhoneInTx(
    tx: Prisma.TransactionClient,
    customerId: string,
    phone: string,
  ): Promise<void> {
    // Most returning senders have a phone already: no lock is taken for them.
    const seen = await tx.customer.findUnique({
      where: { id: customerId },
      select: { phone: true },
    });
    if (!seen || seen.phone !== null) return;
    // Codex F200-1: the row first, then the company key lock, the order customer edits take
    // (update: FOR NO KEY UPDATE, then lockCustomerKeys); both checks again under the locks.
    const [row] = await tx.$queryRaw<{ phone: string | null; number: string }[]>`
      SELECT "phone", "number" FROM "customers" WHERE "id" = ${customerId}::uuid FOR NO KEY UPDATE`;
    if (!row || row.phone !== null) return;
    await lockCustomerKeys(tx);
    if ((await tx.customer.count({ where: { phone } })) > 0) return;
    await tx.customer.update({
      where: { id: customerId },
      data: { phone, phoneUnverified: true },
    });
    await this.audit.recordApi(tx, {
      branchId: null,
      entity: 'CUSTOMER',
      entityId: customerId,
      reference: row.number,
      action: 'UPDATED',
      changes: [
        { field: 'phone', before: null, after: phone },
        { field: 'phoneUnverified', before: 'false', after: 'true' },
      ],
    });
  }

  /**
   * Plan 09e (owner, 2026-11-04): the customer of a person someone else named with an international
   * phone (another sender in the chat). The phone is the key against duplicates: the one customer
   * with it is linked and never changed (one inactive is reported, not linked); several are
   * AMBIGUOUS for staff; none makes a new individual (phoneCustomerCreateInTx).
   */
  async phoneAccountInTx(
    tx: Prisma.TransactionClient,
    input: { name: string; phone: string } & (
      { apiClientId: string; user?: undefined } | { user: AuthUser; apiClientId?: undefined }
    ),
  ): Promise<{
    outcome: 'CREATED' | 'LINKED' | 'INACTIVE' | 'AMBIGUOUS';
    customerId: string | null;
  }> {
    const match = await this.phoneMatchInTx(tx, input.phone);
    if (match.kind === 'AMBIGUOUS') return { outcome: 'AMBIGUOUS', customerId: null };
    if (match.kind === 'ONE')
      return { outcome: match.isActive ? 'LINKED' : 'INACTIVE', customerId: match.customerId };
    return { outcome: 'CREATED', customerId: await this.phoneCustomerCreateInTx(tx, input) };
  }

  /**
   * Plan 09d section 4a (owner, 2026-11-04): the one central customer of a profile, made from its
   * first message (as botAccountInTx, named from the channel until a name is given), or, when it
   * exists, brought up to date: a name given since replaces the channel name it was made with, and
   * a verified phone fills an empty one when no other customer has it. Never merged by phone or
   * name; nothing else is written.
   */
  async channelAccountInTx(
    tx: Prisma.TransactionClient,
    input: {
      profile: {
        id: string;
        version: number;
        needsReview: boolean;
        name: string | null;
        phone: string | null;
        phoneVerified: boolean;
      };
      channelName: string | null;
      apiClientId: string;
    },
  ): Promise<void> {
    const { profile } = input;
    const channelName = input.channelName?.trim() || null;
    const found = await tx.customer.findFirst({
      where: { profileId: profile.id },
      orderBy: PROFILE_ACCOUNT_ORDER,
      select: { id: true },
    });
    if (!found) {
      const name = profile.name?.trim() || channelName;
      if (!name) return;
      await this.botAccountInTx(tx, {
        profile: { ...profile, name },
        expectedVersion: undefined,
        apiClientId: input.apiClientId,
      });
      return;
    }
    // F184-7: the row is locked (as a staff edit locks it) and read again, so the changes below
    // are decided on the customer as it is now: a staff correction or deactivation committed
    // meanwhile is never overwritten. Lock order as update: the row, then the key lock.
    await tx.$queryRaw`SELECT 1 FROM "customers" WHERE "id" = ${found.id}::uuid FOR NO KEY UPDATE`;
    const existing = await tx.customer.findUniqueOrThrow({
      where: { id: found.id },
      select: { id: true, number: true, name: true, phone: true, isActive: true },
    });
    // An inactive customer is staff's to bring back: the channel never changes it.
    if (!existing.isActive) return;
    const changes: { field: string; before: string | null; after: string | null }[] = [];
    const data: Prisma.CustomerUpdateInput = {};
    const given = profile.name?.trim() || null;
    if (given && channelName && existing.name === channelName && given !== existing.name) {
      data.name = given;
      changes.push({ field: 'name', before: existing.name, after: given });
    }
    if (profile.phoneVerified && profile.phone && existing.phone === null) {
      await lockCustomerKeys(tx);
      if ((await tx.customer.count({ where: { phone: profile.phone } })) === 0) {
        data.phone = profile.phone;
        changes.push({ field: 'phoneCopied', before: null, after: 'yes' });
      }
    }
    if (changes.length === 0) return;
    await tx.customer.update({ where: { id: existing.id }, data });
    await this.audit.recordApi(tx, {
      branchId: null,
      entity: 'CUSTOMER',
      entityId: existing.id,
      reference: existing.number,
      action: 'UPDATED',
      // The audit names the fields, never the customer's name or phone (as botAccountInTx).
      changes: changes.map((c) => ({
        field: c.field,
        before: null,
        after: c.field === 'name' ? 'given' : c.after,
      })),
    });
  }

  async list(user: AuthUser, query: CustomerFilters): Promise<Page<CustomerSummaryDto>> {
    const where: Prisma.CustomerWhereInput = {
      ...customerScope(user),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };
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
    return maskCredit(user, toDto(await this.findScoped(user, id)));
  }

  /**
   * A phone, and a tax number when given, is unique in the company: the check runs under the
   * customer lock (shared with update and the Excel import), so two writers cannot both pass it.
   * A duplicate is a 409.
   */
  async create(user: AuthUser, input: CreateCustomerRequest): Promise<CustomerDto> {
    await this.prepareCreate(user, input);
    const created = await this.prisma.$transaction((tx) => this.createInTx(tx, user, input));
    return maskCredit(user, toDto(created));
  }

  /**
   * The checks of a create that need no lock (branch access, references); nothing is written.
   * createInTx then records it, so a caller (an approved assistant draft) can do so inside its own
   * transaction.
   */
  /**
   * The checks of a create that need no lock: the branch is the user's, the references exist.
   * A customer draft still missing values passes only the values it holds.
   */
  async prepareCreate(
    user: AuthUser,
    input: Pick<CreateCustomerRequest, 'branchId'> & Partial<CustomerInput>,
  ): Promise<void> {
    actingBranch(user, input.branchId);
    creditInput(user, input, null);
    await this.checkReferences(input);
    await this.checkSegment(input.segmentCode, null);
  }

  /** Records a customer checked by prepareCreate, under the branch's customer lock. */
  async createInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    input: CustomerWriteFields & { branchId?: string | null },
  ): Promise<CustomerWithDetails> {
    const { branchId: given, acquiredViaOutletId: requested, ...fields } = input;
    const branchId = actingBranch(user, given);
    creditInput(user, input, null);
    // Outlet Staff (plan 4.2): the customer is theirs. Checked first, before any other lock of
    // the write.
    const ownOutletId = await outletForWriteInTx(tx, user, branchId);
    if (!(await lockActiveBranches(tx, [branchId])).has(branchId)) {
      throw new BadRequestException('Unknown or inactive branch');
    }
    const outletId = await this.partnerRefs.chooseInTx(tx, user, {
      kind: 'SALES_OUTLET',
      requested,
      held: ownOutletId,
      // The customer is of no branch (plan 09f): an outlet of any branch where the user adds
      // customers. Outlet Staff stay limited to their own outlet (chooseInTx).
      branchIds: createBranches(user),
      field: 'acquiredViaOutletId',
    });
    await lockCustomerKeys(tx);
    throwFirstConflict(await this.duplicateIssues(tx, [input], user));
    const number = formatShortNumber('CS', await nextSequenceValue(tx, 'CUSTOMER'));
    const customer = await tx.customer.create({
      data: {
        ...toData(fields),
        number,
        acquiredViaOutletId: outletId,
        createdById: user.id,
      },
      include: details,
    });
    await this.audit.record(
      tx,
      user,
      auditRecord(customer, 'CREATED', changedFields(null, auditFields(customer), AUDIT_FIELDS)),
    );
    return customer;
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
    rows: readonly { id: string; input: CustomerInput }[],
  ): Promise<RuleIssue[][]> {
    for (const { input } of rows) creditInput(user, input, null);
    if (rows.length === 0) return [];
    await lockCustomerKeys(tx);
    const duplicates = await this.duplicateIssues(
      tx,
      rows.map((r) => r.input),
      user,
    );
    // Plan 09d (F184-6): unique company-wide inside the batch too, whatever the rows' branches.
    const inBatch = batchDuplicates(rows.map((r) => r.input));
    const issues = rows.map((_, i): RuleIssue[] => [
      ...(duplicates[i] ?? []),
      ...(inBatch[i] ?? []),
    ]);
    if (issues.some((list) => list.length > 0)) return issues;
    const first = await nextSequenceRange(tx, 'CUSTOMER', rows.length);
    const data = rows.map(({ id, input }, i) => {
      return {
        ...toData(input),
        id,
        number: formatShortNumber('CS', first + BigInt(i)),
        createdById: user.id,
      };
    });
    for (let i = 0; i < data.length; i += WRITE_CHUNK) {
      await tx.customer.createMany({ data: data.slice(i, i + WRITE_CHUNK) });
    }
    // Every field as written (defaults included), like a customer created on screen, and where it
    // came from.
    const created = await tx.customer.findMany({
      where: { id: { in: data.map((c) => c.id) } },
      orderBy: { number: 'asc' },
    });
    await this.audit.recordMany(
      tx,
      user,
      created.map((c) =>
        auditRecord(c, 'CREATED', [
          ...changedFields(null, auditFields(c), AUDIT_FIELDS),
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
   *
   * The message names the customer holding the value only when `user` may see that customer: for
   * Outlet Staff (plan 4.2) a holder outside their outlets is "another customer", so the refusal
   * reveals no record they cannot open. The value stays unique across the whole branch.
   */
  async duplicateIssues(
    client: Prisma.TransactionClient,
    candidates: readonly CustomerKeys[],
    user: AuthUser,
  ): Promise<RuleIssue[][]> {
    const phones = [...new Set(candidates.flatMap((c) => (c.phone ? [c.phone] : [])))];
    const taxes = [...new Set(candidates.flatMap((c) => (c.taxNumber ? [c.taxNumber] : [])))];
    if (phones.length === 0 && taxes.length === 0) return candidates.map(() => []);
    // Plan 09d: a customer is the company's, not a branch's: a phone or tax number is unique
    // across all branches (checked for new and changed values only).
    const existing = await client.customer.findMany({
      where: {
        OR: [
          ...(phones.length > 0 ? [{ phone: { in: phones } }] : []),
          ...(taxes.length > 0 ? [{ taxNumber: { in: taxes, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: {
        id: true,
        number: true,
        phone: true,
        taxNumber: true,
        acquiredViaOutletId: true,
      },
    });
    const visible = (c: (typeof existing)[0]) =>
      !outletLimited(user) ||
      (c.acquiredViaOutletId !== null &&
        (user.allowedOutletIds ?? []).includes(c.acquiredViaOutletId));
    const holder = (
      excludeId: string | undefined,
      matches: (c: (typeof existing)[0]) => boolean,
    ) => {
      const found = existing.find((c) => c.id !== excludeId && matches(c));
      if (!found) return undefined;
      return visible(found) ? `Customer ${found.number}` : 'Another customer';
    };
    return candidates.map(({ phone, taxNumber, excludeId }) => {
      const issues: RuleIssue[] = [];
      const samePhone = phone && holder(excludeId, (c) => c.phone === phone);
      if (samePhone) {
        issues.push({
          field: 'phone',
          code: 'DUPLICATE_IN_DB',
          message: `${samePhone} has this phone`,
        });
      }
      const sameTax = taxNumber && holder(excludeId, (c) => sameTaxNumber(taxNumber, c.taxNumber));
      if (sameTax) {
        issues.push({
          field: 'taxNumber',
          code: 'DUPLICATE_IN_DB',
          message: `${sameTax} has this tax number`,
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
  async update(
    user: AuthUser,
    id: string,
    body: Partial<CustomerInput> & { phoneVerified?: true },
  ): Promise<CustomerDto> {
    const { phoneVerified, ...given } = body;
    const read = await this.findScoped(user, id);
    const input = creditInput(user, given, read);
    const withLimit = (c: Customer) => ({
      creditLimit: toDecimalStringOrNull(c.creditLimit),
      creditLimitCurrency: c.creditLimitCurrency,
      ...input,
    });
    await this.checkReferences(withLimit(read));
    await this.checkSegment(input.segmentCode, read.segmentCode);
    const { acquiredViaOutletId: requested, ...fields } = input;
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockRecordOutletInTx(
        tx,
        user,
        'customers',
        read.id,
        'Customer not found',
        'NO KEY UPDATE',
      );
      const current = await tx.customer.findFirst({
        where: { id: read.id, ...customerScope(user) },
      });
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
        excludeId: current.id,
        ...(input.phone !== undefined && input.phone !== current.phone
          ? { phone: input.phone }
          : {}),
        ...(input.taxNumber && !sameTaxNumber(input.taxNumber, current.taxNumber)
          ? { taxNumber: input.taxNumber }
          : {}),
      };
      if (keys.phone !== undefined || keys.taxNumber) {
        await lockCustomerKeys(tx);
        throwFirstConflict(await this.duplicateIssues(tx, [keys], user));
      }
      const acquiredViaOutletId = await this.partnerRefs.chooseInTx(tx, user, {
        kind: 'SALES_OUTLET',
        requested,
        held: current.acquiredViaOutletId,
        branchIds: user.allowedBranchIds,
        field: 'acquiredViaOutletId',
      });
      // Plan 09e (F191-1): a phone staff confirm, or type in place of the old one, is verified.
      const verified =
        phoneVerified === true || (input.phone !== undefined && input.phone !== current.phone);
      const changed = await tx.customer.update({
        where: { id: current.id },
        data: {
          ...toData(fields),
          acquiredViaOutletId,
          ...(verified ? { phoneUnverified: false } : {}),
        },
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
    return maskCredit(user, toDto(updated));
  }

  async setActive(user: AuthUser, id: string, isActive: boolean): Promise<CustomerDto> {
    const existing = await this.findScoped(user, id);
    return maskCredit(
      user,
      toDto(
        await this.prisma.$transaction(async (tx) => {
          // Locked before `before` is read: two concurrent changes queue, and each logs what it
          // actually changed. The outlet is checked as it is now, under that lock.
          await lockRecordOutletInTx(
            tx,
            user,
            'customers',
            existing.id,
            'Customer not found',
            'NO KEY UPDATE',
          );
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
      ),
    );
  }

  async addContact(user: AuthUser, customerId: string, input: ContactInput): Promise<CustomerDto> {
    const customer = await this.findScoped(user, customerId);
    await this.writeContacts(user, customer, async (tx) => {
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
    await this.writeContacts(user, customer, async (tx) => {
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
   * The audit log gets every contact the write changed (the primary flag moved off another one
   * included), read before and after under the lock.
   */
  private async writeContacts(
    user: AuthUser,
    customer: Customer,
    write: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const read = (tx: Prisma.TransactionClient) =>
      tx.customerContact.findMany({ where: { customerId: customer.id } });
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockRecordOutletInTx(
          tx,
          user,
          'customers',
          customer.id,
          'Customer not found',
          'UPDATE',
        );
        const before = await read(tx);
        await write(tx);
        const changes = childChanges('contact', before, await read(tx), CONTACT_AUDIT_FIELDS);
        await this.audit.record(tx, user, auditRecord(customer, 'UPDATED', changes));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A customer has only one primary contact');
      }
      throw error;
    }
  }

  async addParty(
    user: AuthUser,
    customerId: string,
    input: PartyInput,
  ): Promise<CustomerPartyAddedDto> {
    const customer = await this.findScoped(user, customerId);
    let addedPartyId = '';
    await this.writeParties(user, customer, async (tx) => {
      ({ id: addedPartyId } = await tx.party.create({
        data: { ...input, customerId: customer.id },
        select: { id: true },
      }));
    });
    return { ...(await this.get(user, customer.id)), addedPartyId };
  }

  /** For a party draft: the checks of addParty that need no lock (the customer in the user's branches). */
  async prepareAddParty(user: AuthUser, customerId: string): Promise<void> {
    await this.findScoped(user, customerId);
  }

  /** Locks the customer row, as every party change does: the lock an approval takes first. */
  async lockForPartyWrite(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "customers" WHERE "id" = ${customerId}::uuid FOR UPDATE`;
  }

  /**
   * addParty in the caller's transaction (an approved party draft), with its audit log row; the id
   * of the new party. The caller checked access.
   */
  async addPartyInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    customerId: string,
    input: PartyInput,
  ): Promise<string> {
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
    let partyId = '';
    await this.writePartiesInTx(tx, user, customer, async () => {
      partyId = (await tx.party.create({ data: { ...input, customerId }, select: { id: true } }))
        .id;
    });
    return partyId;
  }

  /**
   * The customer's party with this name and phone, or a new one made as addPartyInTx makes it (a
   * bot request's sender and receiver on its approval, owner 2026-11-05). The same name and phone
   * again reuse the party: approvals for the same people make no copies. The caller checked access.
   */
  async partyForInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    customerId: string,
    input: { name: string; phone: string | null },
  ): Promise<string> {
    const name = input.name.trim();
    const phone = input.phone?.trim() || null;
    // Codex F200-2: approvals may already hold the customer row FOR SHARE; upgrading it to the
    // row lock party edits take would deadlock two approvals of one customer. They serialize on
    // a lock of the customer's approval parties instead, taken before the lookup (so two never
    // both make the same party), and insert under the shared row lock the foreign key needs.
    await lockBranchRule(tx, CUSTOMER_PARTIES_RULE, [customerId]);
    const existing = await tx.party.findFirst({
      where: { customerId, name, phone },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (existing) return existing.id;
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
    const before = await tx.party.findMany({ where: { customerId } });
    const { id } = await tx.party.create({
      data: { customerId, name, phone },
      select: { id: true },
    });
    const after = await tx.party.findMany({ where: { customerId } });
    const changes = childChanges('party', before, after, PARTY_AUDIT_FIELDS);
    await this.audit.record(tx, user, auditRecord(customer, 'UPDATED', changes));
    return id;
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
    await this.writeParties(user, customer, async (tx) => {
      await tx.party.update({ where: { id: partyId }, data: input });
    });
    return this.get(user, customer.id);
  }

  /** Party changes, under the customer row lock, with their audit log row (as writeContacts). */
  private async writeParties(
    user: AuthUser,
    customer: Customer,
    write: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction((tx) => this.writePartiesInTx(tx, user, customer, write));
  }

  private async writePartiesInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    customer: Customer,
    write: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const read = () => tx.party.findMany({ where: { customerId: customer.id } });
    await lockRecordOutletInTx(tx, user, 'customers', customer.id, 'Customer not found', 'UPDATE');
    const before = await read();
    await write(tx);
    const changes = childChanges('party', before, await read(), PARTY_AUDIT_FIELDS);
    await this.audit.record(tx, user, auditRecord(customer, 'UPDATED', changes));
  }

  /**
   * For quotations and bookings: the customer must be in the user's branches (404 otherwise, so
   * other branches' customers are not revealed) and active (400).
   */
  /** For other modules: 404 unless the customer is in one of the user's branches. */
  async requireCustomer(user: AuthUser, id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, ...customerScope(user) },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /**
   * The sales outlet a quotation or booking for this customer records, checked inside the write's
   * transaction (plan 4.2): for Outlet Staff, their only outlet as it is now (locked until commit),
   * and the customer must still be one of that outlet's (404 otherwise, as for a customer of
   * another outlet). Null for every other user (their screens do not set an outlet yet).
   */
  async outletForSaleInTx(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    branchId: string,
    customerId: string,
  ): Promise<string | null> {
    const outletId = await outletForWriteInTx(tx, user, branchId);
    await this.lockActiveCustomerInTx(tx, customerId, outletId);
    return outletId;
  }

  /**
   * Re-checks, inside the write's transaction, that the customer a sale was prepared for is still
   * an active customer of that branch (B1-6) and, for Outlet Staff, of their outlet (404 first, as
   * for a customer they cannot see). FOR SHARE conflicts with setActive's row lock, so a
   * deactivation either commits first and is seen here, or waits for the sale to commit.
   */
  async lockActiveCustomerInTx(
    tx: Prisma.TransactionClient,
    customerId: string,
    outletId: string | null = null,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ isActive: boolean; acquiredViaOutletId: string | null }[]>`
      SELECT "is_active" AS "isActive", "acquired_via_outlet_id" AS "acquiredViaOutletId"
      FROM "customers" WHERE "id" = ${customerId}::uuid FOR SHARE`;
    const customer = rows[0];
    if (!customer || (outletId !== null && customer.acquiredViaOutletId !== outletId)) {
      throw new NotFoundException('Customer not found');
    }
    if (!customer.isActive) throw new BadRequestException('Customer is inactive');
  }

  async requireActiveCustomer(user: AuthUser, id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, ...customerScope(user) },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (!customer.isActive) throw new BadRequestException('Customer is inactive');
    return customer;
  }

  /** The ids of the customer's parties, oldest first (the caller checked the customer). */
  async partyIds(customerId: string): Promise<string[]> {
    const parties = await this.prisma.party.findMany({
      where: { customerId },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return parties.map((p) => p.id);
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
      where: { id, ...customerScope(user) },
      include: details,
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /** A segment newly named must be active; one the customer already holds stays. */
  private async checkSegment(code: string | null | undefined, held: string | null): Promise<void> {
    if (!code || code === held) return;
    await onFields(
      ['segmentCode'],
      () => this.masterData.requireCustomerSegment(code),
      'CUSTOMER_SEGMENT_NOT_USABLE',
    );
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

/** For each row, a phone or tax number an earlier row of the same batch already holds. */
function batchDuplicates(
  inputs: readonly { phone?: string | null; taxNumber?: string | null }[],
): RuleIssue[][] {
  const seen = new Set<string>();
  return inputs.map((input) => {
    const found: RuleIssue[] = [];
    const keys: [string | null, 'phone' | 'taxNumber', string][] = [
      [input.phone ? `phone|${input.phone}` : null, 'phone', 'phone'],
      [
        input.taxNumber ? `tax|${normalizeTaxNumber(input.taxNumber)}` : null,
        'taxNumber',
        'tax number',
      ],
    ];
    for (const [key, field, what] of keys) {
      if (key === null) continue;
      if (seen.has(key))
        found.push({ field, code: 'DUPLICATE_IN_FILE', message: `Another row has this ${what}` });
      seen.add(key);
    }
    return found;
  });
}

const details = {
  contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
  parties: { orderBy: { createdAt: 'asc' } },
  acquiredViaOutlet: partnerRefSelect,
} satisfies Prisma.CustomerInclude;

function toData<T extends Partial<CustomerWriteFields>>(
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
  'segmentCode',
  'acquiredViaOutletId',
  'isActive',
  'phoneUnverified',
] as const;

const CONTACT_AUDIT_FIELDS = [
  'name',
  'position',
  'phone',
  'email',
  'idNumber',
  'canInquire',
  'canReceiveCargo',
  'canReceiveDocuments',
  'isPrimary',
  'isActive',
] as const;

const PARTY_AUDIT_FIELDS = [
  'name',
  'companyName',
  'phone',
  'email',
  'countryCode',
  'city',
  'address',
] as const;

/**
 * The audit changes of a customer's contacts or parties: for each one added or changed, a
 * `kind` change naming it (its name before and after; null before when added), then its fields
 * that changed as `kind.field`.
 */
function childChanges<
  T extends { id: string; name: string } & Record<F, AuditValue>,
  F extends string,
>(
  kind: 'contact' | 'party',
  before: readonly T[],
  after: readonly T[],
  fields: readonly F[],
): AuditChangeDto[] {
  const was = new Map(before.map((row) => [row.id, row]));
  return after.flatMap((row) => {
    const old = was.get(row.id) ?? null;
    const pick = (r: T): Record<F, AuditValue> => {
      const out = {} as Record<F, AuditValue>;
      for (const f of fields) out[f] = r[f];
      return out;
    };
    const fieldChanges = changedFields(old && pick(old), pick(row), fields);
    if (fieldChanges.length === 0) return [];
    return [
      { field: kind, before: old?.name ?? null, after: row.name },
      ...fieldChanges.map((c) => ({ ...c, field: `${kind}.${c.field}` })),
    ];
  });
}

function auditFields(c: Customer): Pick<Customer, (typeof AUDIT_FIELDS)[number]> {
  const fields = {} as Record<(typeof AUDIT_FIELDS)[number], unknown>;
  for (const f of AUDIT_FIELDS) fields[f] = c[f];
  return fields as Pick<Customer, (typeof AUDIT_FIELDS)[number]>;
}

/** A customer change for the audit log, named by number and name. */
function auditRecord(
  c: { id: string; number: string; name: string },
  action: 'CREATED' | 'UPDATED',
  changes: AuditChangeDto[],
): AuditRecord {
  return {
    // Plan 09f: a customer is of no branch, and so are the records of its changes.
    branchId: null,
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
    phoneUnverified: c.phoneUnverified,
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
    segmentCode: c.segmentCode,
    acquiredViaOutlet: toPartnerRef(c.acquiredViaOutlet),
    createdAt: c.createdAt.toISOString(),
    contacts: c.contacts.map(toContactDto),
    parties: c.parties.map(toPartyDto),
  };
}

/** Plan 09e: a customer took or gave up the phone while this request ran; trying again is safe. */
function phoneChanged(): ConflictException {
  return new ConflictException({
    code: 'CUSTOMER_PHONE_CHANGED',
    message: 'A customer with this phone changed meanwhile: try again',
  });
}
