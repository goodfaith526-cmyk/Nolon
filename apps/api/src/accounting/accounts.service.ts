import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CONTROL_ROLES,
  ROLE_ACCOUNT_TYPES,
  type AccountDto,
  type AccountInput,
  type AccountingSettingsDto,
  type ChargeTypePostingDto,
  type PostingRole,
} from '@nolon/shared';
import { isUniqueViolation } from '../common/prisma-errors.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Account, Prisma } from '../generated/prisma/client.js';
import { MasterDataService } from '../master-data/master-data.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Chart of accounts and the posting settings (annex C section 4): which account each posting role
 * and each charge type posts to. Accounts are global (not branch-owned); the branch is a dimension
 * on each journal line. Cash and bank accounts hold one currency and may belong to one branch.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currencies: CurrenciesService,
    private readonly masterData: MasterDataService,
  ) {}

  async list(): Promise<AccountDto[]> {
    const [accounts, controlIds] = await Promise.all([
      this.prisma.account.findMany({ orderBy: { code: 'asc' } }),
      this.controlAccountIds(this.prisma),
    ]);
    return accounts.map((a) => toDto(a, controlIds));
  }

  async create(input: AccountInput): Promise<AccountDto> {
    const data = await this.validate(this.prisma, input, null);
    try {
      const account = await this.prisma.account.create({ data });
      return toDto(account, await this.controlAccountIds(this.prisma));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Account code already exists');
      throw error;
    }
  }

  /**
   * Edits an account under its row lock. Journal lines hold the account FOR SHARE while they are
   * written, and mappings take the same share lock, so the checks below count every line and
   * posting rule that can exist when the update commits (the database re-checks lines too).
   */
  async update(id: string, input: AccountInput): Promise<AccountDto> {
    try {
      const account = await this.prisma.$transaction(async (tx) => {
        const existing = await this.lockAccount(tx, id, 'UPDATE');
        const data = await this.validate(tx, input, existing);
        return tx.account.update({ where: { id }, data });
      });
      return toDto(account, await this.controlAccountIds(this.prisma));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Account code already exists');
      throw error;
    }
  }

  async settings(): Promise<AccountingSettingsDto> {
    const [mappings, postings] = await Promise.all([
      this.prisma.accountMapping.findMany({ orderBy: { role: 'asc' } }),
      this.prisma.chargeTypePosting.findMany({ orderBy: { chargeTypeCode: 'asc' } }),
    ]);
    return {
      mappings: mappings.map((m) => ({ role: m.role, accountId: m.accountId })),
      chargeTypes: postings.map(toPostingDto),
    };
  }

  /** Points a posting role at an account of the role's type (ROLE_ACCOUNT_TYPES). */
  async setMapping(role: PostingRole, accountId: string): Promise<AccountingSettingsDto> {
    await this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, accountId, 'SHARE');
      requireUsable(account);
      if (account.isCash) throw new BadRequestException('A cash or bank account cannot be mapped');
      if (account.type !== ROLE_ACCOUNT_TYPES[role]) {
        throw new BadRequestException(
          `${role} posts to a ${ROLE_ACCOUNT_TYPES[role]} account, not ${account.type}`,
        );
      }
      await tx.accountMapping.upsert({
        where: { role },
        create: { role, accountId },
        update: { accountId },
      });
    });
    return this.settings();
  }

  async setChargeTypePosting(input: ChargeTypePostingDto): Promise<AccountingSettingsDto> {
    await this.masterData.requireChargeType(input.chargeTypeCode);
    if (input.isReimbursable && input.revenueAccountId) {
      throw new BadRequestException('A reimbursable charge posts to the reimbursable account');
    }
    const fields = {
      revenueAccountId: input.revenueAccountId,
      isReimbursable: input.isReimbursable,
    };
    await this.prisma.$transaction(async (tx) => {
      if (input.revenueAccountId) {
        const account = await this.lockAccount(tx, input.revenueAccountId, 'SHARE');
        requireUsable(account);
        if (account.type !== 'REVENUE') {
          throw new BadRequestException('Charge types post to a revenue account');
        }
      }
      await tx.chargeTypePosting.upsert({
        where: { chargeTypeCode: input.chargeTypeCode },
        create: { chargeTypeCode: input.chargeTypeCode, ...fields },
        update: fields,
      });
    });
    return this.settings();
  }

  /** The account a posting role maps to. 500 if the mapping is missing: it is seeded. */
  async roleAccount(tx: Tx, role: PostingRole): Promise<string> {
    const mapping = await tx.accountMapping.findUnique({ where: { role } });
    if (!mapping) throw new Error(`No account mapped to ${role}`);
    return mapping.accountId;
  }

  /** Revenue account of each charge type on an invoice (annex C rules 1-2). */
  async revenueAccounts(tx: Tx, chargeTypeCodes: readonly string[]): Promise<Map<string, string>> {
    const codes = [...new Set(chargeTypeCodes)];
    const postings = await tx.chargeTypePosting.findMany({
      where: { chargeTypeCode: { in: codes } },
    });
    const byCode = new Map(postings.map((p) => [p.chargeTypeCode, p]));
    const result = new Map<string, string>();
    for (const code of codes) {
      const posting = byCode.get(code);
      if (posting?.isReimbursable) result.set(code, await this.roleAccount(tx, 'REIMBURSABLE'));
      else if (posting?.revenueAccountId) result.set(code, posting.revenueAccountId);
      else result.set(code, await this.roleAccount(tx, 'DEFAULT_REVENUE'));
    }
    return result;
  }

  /**
   * An active, postable account, read under a share lock: inside a transaction it is held until
   * commit, so the account cannot be deactivated or reclassified under the write that uses it.
   */
  async requirePostable(tx: Tx, id: string): Promise<Account> {
    const account = await this.lockAccount(tx, id, 'SHARE');
    requireUsable(account);
    return account;
  }

  /** Share-locks every account of an entry's lines (in id order) and checks each is usable. */
  async lockForPosting(tx: Tx, ids: readonly string[]): Promise<void> {
    for (const id of [...new Set(ids)].sort()) await this.requirePostable(tx, id);
  }

  /** A cash or bank account usable by the branch, in the given currency. */
  async requireCash(tx: Tx, id: string, branchId: string, currency: string): Promise<Account> {
    const account = await this.requirePostable(tx, id);
    if (!account.isCash) throw new BadRequestException('Not a cash or bank account');
    if (account.branchId !== null && account.branchId !== branchId) {
      throw new BadRequestException('This cash account belongs to another branch');
    }
    if (account.currency !== currency) {
      throw new BadRequestException(`This cash account holds ${account.currency ?? '—'}`);
    }
    return account;
  }

  /**
   * Accounts mapped to a control role, plus every receivable account an approved invoice was
   * posted to (it is still cleared there after a remap): documents post there, manual entries not.
   */
  async controlAccountIds(tx: Tx): Promise<Set<string>> {
    const [mappings, snapshots] = await Promise.all([
      tx.accountMapping.findMany({ where: { role: { in: [...CONTROL_ROLES] } } }),
      tx.customerInvoice.findMany({
        where: { receivableAccountId: { not: null } },
        distinct: ['receivableAccountId'],
        select: { receivableAccountId: true },
      }),
    ]);
    const ids = new Set(mappings.map((m) => m.accountId));
    for (const s of snapshots) if (s.receivableAccountId) ids.add(s.receivableAccountId);
    return ids;
  }

  private async lockAccount(tx: Tx, id: string, mode: 'UPDATE' | 'SHARE'): Promise<Account> {
    const rows =
      mode === 'UPDATE'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "accounts" WHERE "id" = ${id}::uuid FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "accounts" WHERE "id" = ${id}::uuid FOR SHARE`;
    if (rows.length === 0) {
      if (mode === 'UPDATE') throw new NotFoundException('Account not found');
      throw new BadRequestException('Unknown account');
    }
    return tx.account.findUniqueOrThrow({ where: { id } });
  }

  private async validate(tx: Tx, input: AccountInput, existing: Account | null) {
    const isCash = input.isCash ?? false;
    if (isCash) {
      if (input.type !== 'ASSET') throw new BadRequestException('A cash account is an asset');
      if (!input.isPostable) throw new BadRequestException('A cash account is postable');
      if (!input.currency) throw new BadRequestException('A cash account needs a currency');
      await this.currencies.requireActive(input.currency);
      if (input.branchId) {
        const branch = await tx.branch.findUnique({ where: { id: input.branchId } });
        if (!branch) throw new BadRequestException('Unknown branch');
      }
    } else if (input.currency || input.branchId) {
      throw new BadRequestException('Only cash and bank accounts have a currency or branch');
    }
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = await tx.account.findUnique({ where: { id: parentId } });
      if (!parent) throw new BadRequestException('Unknown parent account');
      if (parent.isPostable) throw new BadRequestException('The parent must be a header account');
      if (parent.type !== input.type) {
        throw new BadRequestException('An account has the same type as its parent');
      }
      if (existing && (await this.isDescendant(tx, parentId, existing.id))) {
        throw new BadRequestException('An account cannot sit under itself');
      }
    }
    if (existing) {
      await this.checkChange(tx, existing, input, isCash);
    }
    return {
      code: input.code,
      nameEn: input.nameEn,
      nameAr: input.nameAr,
      type: input.type,
      parentId,
      isPostable: input.isPostable,
      isCash,
      currency: isCash ? (input.currency ?? null) : null,
      branchId: isCash ? (input.branchId ?? null) : null,
      isActive: input.isActive ?? true,
    };
  }

  /**
   * Changes that would rewrite what posted entries mean are refused once an account is used, and
   * an account a posting rule or an approved invoice depends on stays active, postable and of its type.
   */
  private async checkChange(tx: Tx, existing: Account, input: AccountInput, isCash: boolean) {
    const [lines, children, mapped, charged, approvedInvoices] = await Promise.all([
      tx.journalLine.count({ where: { accountId: existing.id } }),
      tx.account.count({ where: { parentId: existing.id } }),
      tx.accountMapping.count({ where: { accountId: existing.id } }),
      tx.chargeTypePosting.count({ where: { revenueAccountId: existing.id } }),
      tx.customerInvoice.count({
        where: { receivableAccountId: existing.id, status: 'APPROVED' },
      }),
    ]);
    if (lines > 0) {
      const changed =
        input.type !== existing.type ||
        !input.isPostable ||
        isCash !== existing.isCash ||
        (input.currency ?? null) !== existing.currency;
      if (changed) {
        throw new ConflictException(
          'This account has entries: its type, currency and kind cannot change',
        );
      }
    }
    if (input.isPostable && children > 0) {
      throw new ConflictException('An account with sub-accounts stays a header account');
    }
    const depended = mapped + charged + approvedInvoices > 0;
    const unusable =
      !input.isPostable || input.isActive === false || isCash || input.type !== existing.type;
    if (depended && unusable) {
      throw new ConflictException(
        'Posting rules or approved invoices use this account; remap them first',
      );
    }
  }

  private async isDescendant(tx: Tx, candidateId: string, ancestorId: string): Promise<boolean> {
    let current: string | null = candidateId;
    for (let depth = 0; current && depth < 50; depth++) {
      if (current === ancestorId) return true;
      const row: { parentId: string | null } | null = await tx.account.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      current = row?.parentId ?? null;
    }
    return false;
  }
}

function requireUsable(account: Account): void {
  if (!account.isActive) throw new BadRequestException(`Account ${account.code} is inactive`);
  if (!account.isPostable) {
    throw new BadRequestException(`Account ${account.code} is a header account`);
  }
}

function toDto(a: Account, controlIds: ReadonlySet<string>): AccountDto {
  return {
    id: a.id,
    code: a.code,
    nameEn: a.nameEn,
    nameAr: a.nameAr,
    type: a.type,
    parentId: a.parentId,
    isPostable: a.isPostable,
    isCash: a.isCash,
    currency: a.currency,
    branchId: a.branchId,
    isActive: a.isActive,
    isControl: controlIds.has(a.id),
  };
}

function toPostingDto(p: {
  chargeTypeCode: string;
  revenueAccountId: string | null;
  isReimbursable: boolean;
}): ChargeTypePostingDto {
  return {
    chargeTypeCode: p.chargeTypeCode,
    revenueAccountId: p.revenueAccountId,
    isReimbursable: p.isReimbursable,
  };
}
