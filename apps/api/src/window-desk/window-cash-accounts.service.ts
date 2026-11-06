import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { WindowCashAccountDto } from '@nolon/shared';
import { AccountsService } from '../accounting/accounts.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { branchScope } from '../auth/branch-scope.js';
import { codedRefusal } from '../common/validation.js';
import { CurrenciesService } from '../currencies/currencies.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

const accountSelect = { select: { code: true, nameAr: true, nameEn: true } } as const;

/**
 * Plan 13 section 4: the cash account each window (a drop-off warehouse a partner outlet runs)
 * takes a customer's money into, per currency. The accountant keeps them
 * (chart_of_accounts:update in the window's branch); an account serves one window and one
 * currency, and must be an active cash account of that currency, of the window's branch or
 * shared. Every change is audited on the warehouse.
 */
@Injectable()
export class WindowCashAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly currencies: CurrenciesService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, warehouseId: string): Promise<WindowCashAccountDto[]> {
    const window = await this.prisma.warehouse.findFirst({
      where: { id: warehouseId, ...branchScope(user) },
      select: { id: true },
    });
    if (!window) throw new NotFoundException('Warehouse not found');
    const rows = await this.prisma.windowCashAccount.findMany({
      where: { warehouseId },
      orderBy: { currency: 'asc' },
      include: { account: accountSelect },
    });
    return rows.map(toDto);
  }

  async set(
    user: AuthUser,
    warehouseId: string,
    currencyCode: string,
    accountId: string,
  ): Promise<WindowCashAccountDto[]> {
    await this.prisma.$transaction(async (tx) => {
      const window = await this.lockWindow(tx, user, warehouseId);
      const currency = await this.currencies.requireActiveInTx(tx, currencyCode);
      // Share-locked, and checked: active, postable, cash, of the currency, the window's branch.
      await this.accounts.requireCash(tx, accountId, window.branchId, currency.code);
      const taken = await tx.windowCashAccount.findUnique({
        where: { accountId },
        select: { warehouseId: true, currency: true },
      });
      if (taken && (taken.warehouseId !== warehouseId || taken.currency !== currency.code)) {
        throw codedRefusal(
          HttpStatus.CONFLICT,
          'WINDOW_CASH_ACCOUNT_TAKEN',
          'This cash account already serves another window or currency',
        );
      }
      const before = await tx.windowCashAccount.findUnique({
        where: { warehouseId_currency: { warehouseId, currency: currency.code } },
        include: { account: accountSelect },
      });
      if (before?.accountId === accountId) return;
      const after = await tx.windowCashAccount.upsert({
        where: { warehouseId_currency: { warehouseId, currency: currency.code } },
        create: { warehouseId, currency: currency.code, accountId, createdById: user.id },
        update: { accountId },
        include: { account: accountSelect },
      });
      await this.audit.record(tx, user, {
        branchId: window.branchId,
        entity: 'WAREHOUSE',
        entityId: warehouseId,
        reference: window.code,
        action: 'UPDATED',
        changes: [
          {
            field: `cashAccount.${currency.code}`,
            before: before?.account.code ?? null,
            after: after.account.code,
          },
        ],
      });
    });
    return this.list(user, warehouseId);
  }

  async remove(
    user: AuthUser,
    warehouseId: string,
    currencyCode: string,
  ): Promise<WindowCashAccountDto[]> {
    await this.prisma.$transaction(async (tx) => {
      const window = await this.lockWindow(tx, user, warehouseId);
      const before = await tx.windowCashAccount.findUnique({
        where: { warehouseId_currency: { warehouseId, currency: currencyCode } },
        include: { account: accountSelect },
      });
      if (!before) return;
      await tx.windowCashAccount.delete({ where: { id: before.id } });
      await this.audit.record(tx, user, {
        branchId: window.branchId,
        entity: 'WAREHOUSE',
        entityId: warehouseId,
        reference: window.code,
        action: 'UPDATED',
        changes: [
          { field: `cashAccount.${currencyCode}`, before: before.account.code, after: null },
        ],
      });
    });
    return this.list(user, warehouseId);
  }

  /**
   * The window row locked for update (as a warehouse edit locks it), in the user's branches, and
   * the right to keep its accounts in its branch.
   */
  private async lockWindow(
    tx: Tx,
    user: AuthUser,
    warehouseId: string,
  ): Promise<{ branchId: string; code: string }> {
    await tx.$queryRaw`SELECT 1 FROM "warehouses" WHERE "id" = ${warehouseId}::uuid FOR UPDATE`;
    const window = await tx.warehouse.findFirst({
      where: { id: warehouseId, ...branchScope(user) },
      select: { branchId: true, code: true },
    });
    if (!window) throw new NotFoundException('Warehouse not found');
    if (!user.access.has('chart_of_accounts:update', window.branchId))
      throw new ForbiddenException('Missing permission');
    return window;
  }
}

function toDto(r: {
  currency: string;
  accountId: string;
  account: { code: string; nameAr: string; nameEn: string };
}): WindowCashAccountDto {
  return {
    currency: r.currency,
    accountId: r.accountId,
    accountCode: r.account.code,
    accountNameAr: r.account.nameAr,
    accountNameEn: r.account.nameEn,
  };
}
