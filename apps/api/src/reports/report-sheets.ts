import {
  AGING_BUCKETS,
  type ApAgingDto,
  type ArAgingDto,
  type BalanceSheetDto,
  type BalanceSheetRowDto,
  type CashMovementDto,
  type GeneralLedgerDto,
  type IncomeStatementDto,
  type IncomeStatementRowDto,
  type InvoicesReceiptsDto,
  type Locale,
  type OpenAccrualsDto,
  type ProfitFiguresDto,
  type ShipmentProfitabilityDto,
  type TrialBalanceDto,
} from '@nolon/shared';
import type { ColumnSpec, RowSpec, SheetSpec, WorkbookSpec } from './excel.js';
import { type LabelKey, type Translate, translator } from './report-labels.js';

/** What every export shows above its tables, besides the dates. */
export interface ExportContext {
  locale: Locale;
  /** The branch code, or null for all the user's branches. */
  branchCode: string | null;
}

interface Named {
  nameEn: string;
  nameAr: string;
}

function localName(locale: Locale, value: Named): string {
  return locale === 'ar' ? value.nameAr : value.nameEn;
}

function workbook(
  ctx: ExportContext,
  title: LabelKey,
  dates: string,
  sheets: SheetSpec[],
  extra: string[] = [],
): WorkbookSpec {
  const t = translator(ctx.locale);
  return {
    locale: ctx.locale,
    title: t(title),
    subtitle: [
      dates,
      `${t('branch')}: ${ctx.branchCode ?? t('allBranches')}`,
      ...extra,
      t('amountsInUsd'),
    ],
    sheets,
  };
}

const text = (header: string, width?: number): ColumnSpec => ({ header, kind: 'text', width });
const amount = (header: string): ColumnSpec => ({ header, kind: 'amount' });
const date = (header: string): ColumnSpec => ({ header, kind: 'date' });

function periodLine(t: Translate, from: string, to: string): string {
  return `${t('period')}: ${from} - ${to}`;
}

function asOfLine(t: Translate, asOf: string): string {
  return `${t('asOf')}: ${asOf}`;
}

export function trialBalanceSheets(ctx: ExportContext, r: TrialBalanceDto): WorkbookSpec {
  const t = translator(ctx.locale);
  const columns = [
    text(t('code'), 10),
    text(t('account'), 36),
    text(t('type'), 14),
    amount(t('debitUsd')),
    amount(t('creditUsd')),
    amount(t('balanceUsd')),
  ];
  const rows: RowSpec[] = r.rows.map((row) => ({
    cells: [
      row.code,
      localName(ctx.locale, row),
      t(row.type),
      row.debitUsd,
      row.creditUsd,
      row.balanceUsd,
    ],
  }));
  rows.push({
    cells: [null, t('total'), null, r.totalDebitUsd, r.totalCreditUsd, null],
    bold: true,
  });
  return workbook(ctx, 'trialBalance', asOfLine(t, r.asOf), [
    { name: t('trialBalance'), columns, rows },
  ]);
}

export function incomeStatementSheets(ctx: ExportContext, r: IncomeStatementDto): WorkbookSpec {
  const t = translator(ctx.locale);
  const columns = [
    text(t('code'), 10),
    text(t('account'), 36),
    ...r.branches.map((b) => amount(b.code)),
    amount(t('totalUsd')),
  ];
  const blanks = r.branches.map(() => null);
  const line = (row: IncomeStatementRowDto): RowSpec => ({
    cells: [row.code, localName(ctx.locale, row), ...row.byBranch, row.total],
  });
  const totalLine = (label: LabelKey, a: { byBranch: string[]; total: string }): RowSpec => ({
    cells: [null, t(label), ...a.byBranch, a.total],
    bold: true,
  });
  const rows: RowSpec[] = [
    { cells: [null, t('revenue'), ...blanks, null], bold: true },
    ...r.revenue.map(line),
    totalLine('totalRevenue', r.totalRevenue),
    { cells: [] },
    { cells: [null, t('expenses'), ...blanks, null], bold: true },
    ...r.expenses.map(line),
    totalLine('totalExpenses', r.totalExpenses),
    { cells: [] },
    totalLine('netIncome', r.netIncome),
  ];
  return workbook(ctx, 'incomeStatement', periodLine(t, r.from, r.to), [
    { name: t('incomeStatement'), columns, rows },
  ]);
}

export function balanceSheetSheets(ctx: ExportContext, r: BalanceSheetDto): WorkbookSpec {
  const t = translator(ctx.locale);
  const columns = [text(t('code'), 10), text(t('account'), 40), amount(t('balanceUsd'))];
  const line = (row: BalanceSheetRowDto): RowSpec => ({
    cells: [row.code, localName(ctx.locale, row), row.balanceUsd],
  });
  const heading = (label: LabelKey): RowSpec => ({ cells: [null, t(label)], bold: true });
  const total = (label: LabelKey, value: string): RowSpec => ({
    cells: [null, t(label), value],
    bold: true,
  });
  const rows: RowSpec[] = [
    heading('assets'),
    ...r.assets.map(line),
    total('totalAssets', r.totalAssetsUsd),
    { cells: [] },
    heading('liabilities'),
    ...r.liabilities.map(line),
    total('totalLiabilities', r.totalLiabilitiesUsd),
    { cells: [] },
    heading('equity'),
    ...r.equity.map(line),
    { cells: [null, t('unclosedEarnings'), r.unclosedEarningsUsd] },
    total('totalEquity', r.totalEquityUsd),
    { cells: [] },
    total('totalLiabilitiesAndEquity', r.totalLiabilitiesAndEquityUsd),
  ];
  return workbook(ctx, 'balanceSheet', asOfLine(t, r.asOf), [
    { name: t('balanceSheet'), columns, rows },
  ]);
}

export function generalLedgerSheets(ctx: ExportContext, r: GeneralLedgerDto): WorkbookSpec {
  const t = translator(ctx.locale);
  const columns = [
    date(t('date')),
    text(t('entry'), 22),
    text(t('description'), 44),
    text(t('branch'), 8),
    text(t('currency'), 8),
    amount(t('debit')),
    amount(t('credit')),
    amount(t('debitUsd')),
    amount(t('creditUsd')),
    amount(t('balanceUsd')),
  ];
  const rows: RowSpec[] = [];
  for (const a of r.accounts) {
    rows.push({ cells: [null, a.code, localName(ctx.locale, a)], bold: true });
    rows.push({
      cells: [r.from, null, t('openingBalance'), null, null, null, null, null, null, a.openingUsd],
    });
    for (const l of a.lines) {
      rows.push({
        cells: [
          l.entryDate,
          l.entryNumber,
          l.description,
          l.branchCode,
          l.currency,
          l.debit,
          l.credit,
          l.debitUsd,
          l.creditUsd,
          l.balanceUsd,
        ],
      });
    }
    rows.push({
      cells: [
        r.to,
        null,
        t('closingBalance'),
        null,
        null,
        null,
        null,
        a.totalDebitUsd,
        a.totalCreditUsd,
        a.closingUsd,
      ],
      bold: true,
    });
    rows.push({ cells: [] });
  }
  return workbook(ctx, 'generalLedger', periodLine(t, r.from, r.to), [
    { name: t('generalLedger'), columns, rows },
  ]);
}

export function arAgingSheets(
  ctx: ExportContext,
  r: ArAgingDto,
  customerName: string | null,
): WorkbookSpec {
  const t = translator(ctx.locale);
  const bucketColumns = AGING_BUCKETS.map((b) => amount(t(b)));
  const summary: SheetSpec = {
    name: t('byCustomer'),
    columns: [
      text(t('customer'), 36),
      ...bucketColumns,
      amount(t('totalUsd')),
      amount(t('advancesUsd')),
      amount(t('netUsd')),
    ],
    rows: [
      ...r.customers.map((c) => ({
        cells: [
          c.customerName,
          ...AGING_BUCKETS.map((b) => c.amounts[b]),
          c.amounts.total,
          c.advancesUsd,
          c.netUsd,
        ],
      })),
      {
        cells: [
          t('total'),
          ...AGING_BUCKETS.map((b) => r.totals[b]),
          r.totals.total,
          r.totalAdvancesUsd,
          r.netUsd,
        ],
        bold: true,
      },
    ],
  };
  const invoices: SheetSpec = {
    name: t('invoices'),
    columns: [
      text(t('number'), 22),
      text(t('branch'), 8),
      text(t('customer'), 30),
      date(t('invoiceDate')),
      date(t('dueDate')),
      text(t('currency'), 8),
      amount(t('total')),
      amount(t('outstanding')),
      amount(t('outstandingUsd')),
      { header: t('daysPastDue'), kind: 'integer' },
      text(t('bucket'), 14),
    ],
    rows: r.invoices.map((i) => ({
      cells: [
        i.number,
        i.branchCode,
        i.customerName,
        i.invoiceDate,
        i.dueDate,
        i.currency,
        i.total,
        i.outstanding,
        i.outstandingUsd,
        i.daysPastDue,
        t(i.bucket),
      ],
    })),
  };
  const extra = customerName ? [`${t('customerFilter')}: ${customerName}`] : [];
  return workbook(ctx, 'arAging', asOfLine(t, r.asOf), [summary, invoices], extra);
}

function profitCells(f: ProfitFiguresDto): (string | null)[] {
  return [f.revenueUsd, f.costUsd, f.marginUsd, f.marginPercent];
}

export function profitabilitySheets(
  ctx: ExportContext,
  r: ShipmentProfitabilityDto,
  customerName: string | null,
): WorkbookSpec {
  const t = translator(ctx.locale);
  const figures = [
    amount(t('revenueUsd')),
    amount(t('costUsd')),
    amount(t('marginUsd')),
    { header: t('marginPercent'), kind: 'percent' } satisfies ColumnSpec,
  ];
  const place = (l: Named & { code: string }) => `${l.code} ${localName(ctx.locale, l)}`;
  const totals = (count: number | null, leading: number): RowSpec => ({
    cells: [
      t('total'),
      ...Array.from({ length: leading }, () => null),
      ...(count === null ? [] : [count]),
      ...profitCells(r.totals),
    ],
    bold: true,
  });
  const shipments: SheetSpec = {
    name: t('shipments'),
    columns: [
      text(t('shipment'), 22),
      text(t('branch'), 8),
      text(t('customer'), 30),
      text(t('origin'), 22),
      text(t('destination'), 22),
      ...figures,
    ],
    rows: [
      ...r.shipments.map((s) => ({
        cells: [
          s.number,
          s.branchCode,
          s.customerName,
          place(s.origin),
          place(s.destination),
          ...profitCells(s),
        ],
      })),
      totals(null, 4),
    ],
  };
  const customers: SheetSpec = {
    name: t('customers'),
    columns: [text(t('customer'), 36), { header: t('shipmentCount'), kind: 'integer' }, ...figures],
    rows: [
      ...r.customers.map((c) => ({ cells: [c.customerName, c.shipments, ...profitCells(c)] })),
      totals(r.shipments.length, 0),
    ],
  };
  const routes: SheetSpec = {
    name: t('routes'),
    columns: [
      text(t('origin'), 24),
      text(t('destination'), 24),
      { header: t('shipmentCount'), kind: 'integer' },
      ...figures,
    ],
    rows: [
      ...r.routes.map((x) => ({
        cells: [place(x.origin), place(x.destination), x.shipments, ...profitCells(x)],
      })),
      totals(r.shipments.length, 1),
    ],
  };
  const extra = customerName ? [`${t('customerFilter')}: ${customerName}`] : [];
  return workbook(
    ctx,
    'profitability',
    periodLine(t, r.from, r.to),
    [shipments, customers, routes],
    extra,
  );
}

export function invoicesReceiptsSheets(
  ctx: ExportContext,
  r: InvoicesReceiptsDto,
  customerName: string | null,
): WorkbookSpec {
  const t = translator(ctx.locale);
  const invoices: SheetSpec = {
    name: t('invoices'),
    columns: [
      text(t('number'), 22),
      date(t('invoiceDate')),
      date(t('dueDate')),
      text(t('branch'), 8),
      text(t('customer'), 30),
      text(t('shipment'), 22),
      text(t('currency'), 8),
      amount(t('total')),
      amount(t('totalUsd')),
    ],
    rows: [
      ...r.invoices.map((i) => ({
        cells: [
          i.number,
          i.invoiceDate,
          i.dueDate,
          i.branchCode,
          i.customerName,
          i.shipmentNumber,
          i.currency,
          i.total,
          i.totalUsd,
        ],
      })),
      {
        cells: [t('total'), null, null, null, null, null, null, null, r.totalInvoicedUsd],
        bold: true,
      },
    ],
  };
  const receipts: SheetSpec = {
    name: t('receipts'),
    columns: [
      text(t('number'), 22),
      date(t('receiptDate')),
      text(t('branch'), 8),
      text(t('customer'), 30),
      text(t('cashAccount'), 14),
      text(t('currency'), 8),
      amount(t('amount')),
      amount(t('amountUsd')),
      text(t('status'), 10),
    ],
    rows: [
      ...r.receipts.map((x) => ({
        cells: [
          x.number,
          x.receiptDate,
          x.branchCode,
          x.customerName,
          x.cashAccountCode,
          x.currency,
          x.amount,
          x.amountUsd,
          t(x.status === 'POSTED' ? 'posted' : 'cancelled'),
        ],
      })),
      { cells: [t('total'), null, null, null, null, null, null, r.totalReceivedUsd], bold: true },
    ],
  };
  const extra = customerName ? [`${t('customerFilter')}: ${customerName}`] : [];
  return workbook(
    ctx,
    'invoicesReceipts',
    periodLine(t, r.from, r.to),
    [invoices, receipts],
    extra,
  );
}

export function cashMovementSheets(ctx: ExportContext, r: CashMovementDto): WorkbookSpec {
  const t = translator(ctx.locale);
  const accounts: SheetSpec = {
    name: t('accounts'),
    columns: [
      text(t('code'), 10),
      text(t('account'), 30),
      text(t('currency'), 8),
      amount(t('opening')),
      amount(t('inflow')),
      amount(t('outflow')),
      amount(t('closing')),
      amount(t('openingUsd')),
      amount(t('inflowUsd')),
      amount(t('outflowUsd')),
      amount(t('closingUsd')),
    ],
    rows: [
      ...r.accounts.map((a) => ({
        cells: [
          a.code,
          localName(ctx.locale, a),
          a.currency,
          a.opening,
          a.inflow,
          a.outflow,
          a.closing,
          a.openingUsd,
          a.inflowUsd,
          a.outflowUsd,
          a.closingUsd,
        ],
      })),
      {
        cells: [
          null,
          t('total'),
          null,
          null,
          null,
          null,
          null,
          r.totals.openingUsd,
          r.totals.inflowUsd,
          r.totals.outflowUsd,
          r.totals.closingUsd,
        ],
        bold: true,
      },
    ],
  };
  const fx: SheetSpec = {
    name: t('fxDifferences'),
    columns: [
      date(t('date')),
      text(t('entry'), 22),
      text(t('description'), 44),
      text(t('branch'), 8),
      amount(t('amountUsd')),
    ],
    rows: [
      ...r.fx.lines.map((l) => ({
        cells: [l.entryDate, l.entryNumber, l.description, l.branchCode, l.amountUsd],
      })),
      { cells: [] },
      { cells: [null, null, t('fxGain'), null, r.fx.gainUsd], bold: true },
      { cells: [null, null, t('fxLoss'), null, r.fx.lossUsd], bold: true },
      { cells: [null, null, t('fxNet'), null, r.fx.netUsd], bold: true },
    ],
  };
  return workbook(ctx, 'cashMovement', periodLine(t, r.from, r.to), [accounts, fx]);
}

export function openAccrualsSheets(ctx: ExportContext, r: OpenAccrualsDto): WorkbookSpec {
  const t = translator(ctx.locale);
  const trips: SheetSpec = {
    name: t('trips'),
    columns: [
      text(t('trip'), 22),
      text(t('branch'), 8),
      text(t('carrier'), 30),
      date(t('completedOn')),
      text(t('currency'), 8),
      amount(t('accruedBalance')),
      amount(t('balanceUsd')),
    ],
    rows: r.trips.map((x) => ({
      cells: [
        x.tripNumber,
        x.branchCode,
        x.carrierName,
        x.completedAt,
        x.currency,
        x.balance,
        x.balanceUsd,
      ],
    })),
  };
  const account = (a: OpenAccrualsDto['accruedAccount']) =>
    a ? `${a.code} ${localName(ctx.locale, a)}` : null;
  const summary: SheetSpec = {
    name: t('summary'),
    columns: [text(t('item'), 44), text(t('account'), 36), amount(t('balanceUsd'))],
    rows: [
      {
        cells: [t('trips'), account(r.accruedAccount), r.tripsTotalUsd],
      },
      { cells: [t('otherAccrued'), account(r.accruedAccount), r.otherAccruedUsd] },
      { cells: [t('accruedTotal'), account(r.accruedAccount), r.accruedTotalUsd], bold: true },
      { cells: [] },
      {
        cells: [t('clearingBalance'), account(r.clearingAccount), r.clearingBalanceUsd],
        bold: true,
      },
    ],
  };
  return workbook(ctx, 'openAccruals', asOfLine(t, r.asOf), [trips, summary]);
}

export function apAgingSheets(
  ctx: ExportContext,
  r: ApAgingDto,
  supplierName: string | null,
): WorkbookSpec {
  const t = translator(ctx.locale);
  const summary: SheetSpec = {
    name: t('bySupplier'),
    columns: [
      text(t('supplier'), 36),
      ...AGING_BUCKETS.map((b) => amount(t(b))),
      amount(t('totalUsd')),
    ],
    rows: [
      ...r.suppliers.map((s) => ({
        cells: [s.supplierName, ...AGING_BUCKETS.map((b) => s.amounts[b]), s.amounts.total],
      })),
      {
        cells: [t('total'), ...AGING_BUCKETS.map((b) => r.totals[b]), r.totals.total],
        bold: true,
      },
    ],
  };
  const bills: SheetSpec = {
    name: t('bills'),
    columns: [
      text(t('number'), 22),
      text(t('supplierReference'), 18),
      text(t('branch'), 8),
      text(t('supplier'), 30),
      date(t('billDate')),
      date(t('dueDate')),
      text(t('currency'), 8),
      amount(t('total')),
      amount(t('outstanding')),
      amount(t('outstandingUsd')),
      { header: t('daysPastDue'), kind: 'integer' },
      text(t('bucket'), 14),
    ],
    rows: r.bills.map((b) => ({
      cells: [
        b.number,
        b.supplierReference ?? '',
        b.branchCode,
        b.supplierName,
        b.billDate,
        b.dueDate,
        b.currency,
        b.total,
        b.outstanding,
        b.outstandingUsd,
        b.daysPastDue,
        t(b.bucket),
      ],
    })),
  };
  const extra = supplierName ? [`${t('supplierFilter')}: ${supplierName}`] : [];
  return workbook(ctx, 'apAging', asOfLine(t, r.asOf), [summary, bills], extra);
}
