import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CONTROL_ROLES,
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
    const data = await this.validate(input, null);
    try {
      const account = await this.prisma.account.create({ data });
      return toDto(account, await this.controlAccountIds(this.prisma));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Account code already exists');
      throw error;
    }
  }

  async update(id: string, input: AccountInput): Promise<AccountDto> {
    const existing = await this.prisma.account.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Account not found');
    const data = await this.validate(input, existing);
    try {
      const account = await this.prisma.account.update({ where: { id }, data });
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

  async setMapping(role: PostingRole, accountId: string): Promise<AccountingSettingsDto> {
    const account = await this.requirePostable(this.prisma, accountId);
    if (account.isCash) throw new BadRequestException('A cash or bank account cannot be mapped');
    await this.prisma.accountMapping.upsert({
      where: { role },
      create: { role, accountId },
      update: { accountId },
    });
    return this.settings();
  }

  async setChargeTypePosting(input: ChargeTypePostingDto): Promise<AccountingSettingsDto> {
    await this.masterData.requireChargeType(input.chargeTypeCode);
    if (input.isReimbursable && input.revenueAccountId) {
      throw new BadRequestException('A reimbursable charge posts to the reimbursable account');
    }
    if (input.revenueAccountId) {
      const account = await this.requirePostable(this.prisma, input.revenueAccountId);
      if (account.type !== 'REVENUE') {
        throw new BadRequestException('Charge types post to a revenue account');
      }
    }
    const fields = {
      revenueAccountId: input.revenueAccountId,
      isReimbursable: input.isReimbursable,
    };
    await this.prisma.chargeTypePosting.upsert({
      where: { chargeTypeCode: input.chargeTypeCode },
      create: { chargeTypeCode: input.chargeTypeCode, ...fields },
      update: fields,
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

  async requirePostable(tx: Tx, id: string): Promise<Account> {
    const account = await tx.account.findUnique({ where: { id } });
    if (!account) throw new BadRequestException('Unknown account');
    if (!account.isActive) throw new BadRequestException(`Account ${account.code} is inactive`);
    if (!account.isPostable) {
      throw new BadRequestException(`Account ${account.code} is a header account`);
    }
    return account;
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

  /** Accounts mapped to a control role: invoices and receipts post there, manual entries not. */
  async controlAccountIds(tx: Tx): Promise<Set<string>> {
    const mappings = await tx.accountMapping.findMany({
      where: { role: { in: [...CONTROL_ROLES] } },
    });
    return new Set(mappings.map((m) => m.accountId));
  }

  private async validate(input: AccountInput, existing: Account | null) {
    const isCash = input.isCash ?? false;
    if (isCash) {
      if (!input.isPostable) throw new BadRequestException('A cash account is postable');
      if (!input.currency) throw new BadRequestException('A cash account needs a currency');
      await this.currencies.requireActive(input.currency);
      if (input.branchId) {
        const branch = await this.prisma.branch.findUnique({ where: { id: input.branchId } });
        if (!branch) throw new BadRequestException('Unknown branch');
      }
    } else if (input.currency || input.branchId) {
      throw new BadRequestException('Only cash and bank accounts have a currency or branch');
    }
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = await this.prisma.account.findUnique({ where: { id: parentId } });
      if (!parent) throw new BadRequestException('Unknown parent account');
      if (parent.isPostable) throw new BadRequestException('The parent must be a header account');
      if (parent.type !== input.type) {
        throw new BadRequestException('An account has the same type as its parent');
      }
      if (existing && (await this.isDescendant(parentId, existing.id))) {
        throw new BadRequestException('An account cannot sit under itself');
      }
    }
    if (existing) {
      await this.checkChange(existing, input, isCash);
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

  /** Changes that would rewrite what posted entries mean are refused once an account is used. */
  private async checkChange(existing: Account, input: AccountInput, isCash: boolean) {
    const [lines, children, mapped] = await Promise.all([
      this.prisma.journalLine.count({ where: { accountId: existing.id } }),
      this.prisma.account.count({ where: { parentId: existing.id } }),
      this.prisma.accountMapping.count({ where: { accountId: existing.id } }),
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
    if (mapped > 0 && (!input.isPostable || input.isActive === false || isCash)) {
      throw new ConflictException('This account is used by a posting rule; remap it first');
    }
  }

  private async isDescendant(candidateId: string, ancestorId: string): Promise<boolean> {
    let current: string | null = candidateId;
    for (let depth = 0; current && depth < 50; depth++) {
      if (current === ancestorId) return true;
      const row: { parentId: string | null } | null = await this.prisma.account.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      current = row?.parentId ?? null;
    }
    return false;
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
