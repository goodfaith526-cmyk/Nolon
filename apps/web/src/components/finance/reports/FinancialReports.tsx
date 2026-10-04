'use client';

import {
  AGING_BUCKETS,
  type ArAgingDto,
  type BalanceSheetDto,
  type BalanceSheetRowDto,
  type BranchAmountsDto,
  type CashMovementDto,
  type GeneralLedgerDto,
  type IncomeStatementDto,
  type IncomeStatementRowDto,
  type InvoicesReceiptsDto,
  type OpenAccrualsDto,
  type ProfitFiguresDto,
  type ReportLocationDto,
  type ShipmentProfitabilityDto,
} from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useLocalName } from '@/lib/master-data';
import { Money } from '../common';
import { AmountCell, BranchHeads, EmptyRow, ReportTable, ReportView } from './ReportKit';

export function IncomeStatement() {
  const t = useTranslations('Reports');
  const name = useLocalName();
  return (
    <ReportView<IncomeStatementDto>
      id="income-statement"
      permission="financial_reports:view"
      title={t('incomeStatement')}
      hint={t('incomeStatementHint')}
      filters={{ dates: 'period' }}
    >
      {(r) => {
        const columns = r.branches.length + 3;
        const line = (row: IncomeStatementRowDto) => (
          <tr key={row.accountId}>
            <td dir="ltr">{row.code}</td>
            <td>{name(row)}</td>
            {row.byBranch.map((v, i) => (
              <AmountCell key={r.branches[i]?.id ?? i} value={v} />
            ))}
            <AmountCell value={row.total} />
          </tr>
        );
        const total = (label: string, a: BranchAmountsDto, strong = false) => (
          <tr className="subtotal">
            <td />
            <td>{label}</td>
            {a.byBranch.map((v, i) => (
              <AmountCell key={r.branches[i]?.id ?? i} value={v} strong={strong} />
            ))}
            <AmountCell value={a.total} strong={strong} />
          </tr>
        );
        const heading = (label: string) => (
          <tr className="heading">
            <td colSpan={columns}>{label}</td>
          </tr>
        );
        return (
          <ReportTable>
            <thead>
              <tr>
                <th>{t('code')}</th>
                <th>{t('account')}</th>
                <BranchHeads branches={r.branches} total={t('totalUsd')} />
              </tr>
            </thead>
            <tbody>
              {heading(t('revenue'))}
              {r.revenue.length === 0 && <EmptyRow columns={columns} text={t('noLines')} />}
              {r.revenue.map(line)}
              {total(t('totalRevenue'), r.totalRevenue)}
              {heading(t('expenses'))}
              {r.expenses.length === 0 && <EmptyRow columns={columns} text={t('noLines')} />}
              {r.expenses.map(line)}
              {total(t('totalExpenses'), r.totalExpenses)}
              {total(t('netIncome'), r.netIncome, true)}
            </tbody>
          </ReportTable>
        );
      }}
    </ReportView>
  );
}

export function BalanceSheet() {
  const t = useTranslations('Reports');
  const name = useLocalName();
  return (
    <ReportView<BalanceSheetDto>
      id="balance-sheet"
      permission="financial_reports:view"
      title={t('balanceSheet')}
      hint={t('balanceSheetHint')}
      filters={{ dates: 'asOf' }}
    >
      {(r) => {
        const section = (label: string, rows: BalanceSheetRowDto[]) => (
          <>
            <tr className="heading">
              <td colSpan={3}>{label}</td>
            </tr>
            {rows.length === 0 && <EmptyRow columns={3} text={t('noLines')} />}
            {rows.map((row) => (
              <tr key={row.accountId}>
                <td dir="ltr">{row.code}</td>
                <td>{name(row)}</td>
                <AmountCell value={row.balanceUsd} />
              </tr>
            ))}
          </>
        );
        const total = (label: string, value: string, strong = false) => (
          <tr className="subtotal">
            <td />
            <td>{label}</td>
            <AmountCell value={value} strong={strong} />
          </tr>
        );
        return (
          <>
            <p className={r.balanced ? 'success' : 'error'}>
              {r.balanced ? t('balanced') : t('notBalanced')}
            </p>
            <ReportTable>
              <thead>
                <tr>
                  <th>{t('code')}</th>
                  <th>{t('account')}</th>
                  <th>{t('balanceUsd')}</th>
                </tr>
              </thead>
              <tbody>
                {section(t('assets'), r.assets)}
                {total(t('totalAssets'), r.totalAssetsUsd, true)}
                {section(t('liabilities'), r.liabilities)}
                {total(t('totalLiabilities'), r.totalLiabilitiesUsd)}
                {section(t('equity'), r.equity)}
                <tr>
                  <td />
                  <td>{t('unclosedEarnings')}</td>
                  <AmountCell value={r.unclosedEarningsUsd} />
                </tr>
                {total(t('totalEquity'), r.totalEquityUsd)}
                {total(t('totalLiabilitiesAndEquity'), r.totalLiabilitiesAndEquityUsd, true)}
              </tbody>
            </ReportTable>
          </>
        );
      }}
    </ReportView>
  );
}

export function GeneralLedger() {
  const t = useTranslations('Reports');
  const te = useTranslations('Enums');
  const name = useLocalName();
  return (
    <ReportView<GeneralLedgerDto>
      id="general-ledger"
      permission="financial_reports:view"
      title={t('generalLedger')}
      hint={t('generalLedgerHint')}
      filters={{ dates: 'period', accounts: true }}
    >
      {(r) => (
        <div className="stack">
          {r.accounts.map((a) => (
            <ReportTable key={a.accountId} title={`${a.code} · ${name(a)}`}>
              <thead>
                <tr>
                  <th>{t('date')}</th>
                  <th>{t('entry')}</th>
                  <th>{t('description')}</th>
                  <th>{t('branch')}</th>
                  <th>{t('amount')}</th>
                  <th>{t('debitUsd')}</th>
                  <th>{t('creditUsd')}</th>
                  <th>{t('balanceUsd')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className="subtotal">
                  <td dir="ltr">{r.from}</td>
                  <td />
                  <td>{t('openingBalance')}</td>
                  <td />
                  <td />
                  <td />
                  <td />
                  <AmountCell value={a.openingUsd} />
                </tr>
                {a.lines.map((l, i) => (
                  <tr key={`${l.entryId}-${i}`}>
                    <td dir="ltr">{l.entryDate}</td>
                    <td dir="ltr">
                      <Link href={`/accounting/journals/${l.entryId}`}>{l.entryNumber}</Link>
                    </td>
                    <td className="wrap">
                      <span className="muted">{te(`journalSource_${l.source}`)}</span> ·{' '}
                      {l.description}
                    </td>
                    <td dir="ltr">{l.branchCode}</td>
                    <td dir="ltr">
                      <Money value={l.debit === '0' ? l.credit : l.debit} currency={l.currency} />
                    </td>
                    <AmountCell value={l.debitUsd} />
                    <AmountCell value={l.creditUsd} />
                    <AmountCell value={l.balanceUsd} />
                  </tr>
                ))}
                <tr className="subtotal">
                  <td dir="ltr">{r.to}</td>
                  <td />
                  <td>{t('closingBalance')}</td>
                  <td />
                  <td />
                  <AmountCell value={a.totalDebitUsd} />
                  <AmountCell value={a.totalCreditUsd} />
                  <AmountCell value={a.closingUsd} strong />
                </tr>
              </tbody>
            </ReportTable>
          ))}
        </div>
      )}
    </ReportView>
  );
}

export function ArAging() {
  const t = useTranslations('Reports');
  return (
    <ReportView<ArAgingDto>
      id="ar-aging"
      permission="financial_reports:view"
      title={t('arAging')}
      hint={t('arAgingHint')}
      filters={{ dates: 'asOf', customer: true }}
    >
      {(r) => (
        <div className="stack">
          <ReportTable title={t('byCustomer')}>
            <thead>
              <tr>
                <th>{t('customer')}</th>
                {AGING_BUCKETS.map((b) => (
                  <th key={b}>{t(`bucket_${b}`)}</th>
                ))}
                <th>{t('totalUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {r.customers.length === 0 && <EmptyRow columns={7} text={t('nothingOpen')} />}
              {r.customers.map((c) => (
                <tr key={c.customerId}>
                  <td>{c.customerName}</td>
                  {AGING_BUCKETS.map((b) => (
                    <AmountCell key={b} value={c.amounts[b]} />
                  ))}
                  <AmountCell value={c.amounts.total} strong />
                </tr>
              ))}
              <tr className="subtotal">
                <td>{t('total')}</td>
                {AGING_BUCKETS.map((b) => (
                  <AmountCell key={b} value={r.totals[b]} />
                ))}
                <AmountCell value={r.totals.total} strong />
              </tr>
            </tbody>
          </ReportTable>
          <ReportTable title={t('invoices')}>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('customer')}</th>
                <th>{t('dueDate')}</th>
                <th>{t('daysPastDue')}</th>
                <th>{t('outstanding')}</th>
                <th>{t('outstandingUsd')}</th>
                <th>{t('bucket')}</th>
              </tr>
            </thead>
            <tbody>
              {r.invoices.length === 0 && <EmptyRow columns={7} text={t('nothingOpen')} />}
              {r.invoices.map((i) => (
                <tr key={i.invoiceId}>
                  <td dir="ltr">
                    <Link href={`/invoices/${i.invoiceId}`}>{i.number}</Link>
                  </td>
                  <td>{i.customerName}</td>
                  <td dir="ltr">{i.dueDate}</td>
                  <td dir="ltr">{i.daysPastDue}</td>
                  <td dir="ltr">
                    <Money value={i.outstanding} currency={i.currency} />
                  </td>
                  <AmountCell value={i.outstandingUsd} />
                  <td>{t(`bucket_${i.bucket}`)}</td>
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
      )}
    </ReportView>
  );
}

export function ShipmentProfitability() {
  const t = useTranslations('Reports');
  const name = useLocalName();
  const place = (l: ReportLocationDto) => `${l.code} · ${name(l)}`;
  const figures = (f: ProfitFiguresDto, strong = false) => (
    <>
      <AmountCell value={f.revenueUsd} strong={strong} />
      <AmountCell value={f.costUsd} strong={strong} />
      <AmountCell value={f.marginUsd} strong={strong} />
      <td dir="ltr">{f.marginPercent === null ? '—' : `${f.marginPercent}%`}</td>
    </>
  );
  const figureHeads = (
    <>
      <th>{t('revenueUsd')}</th>
      <th>{t('costUsd')}</th>
      <th>{t('marginUsd')}</th>
      <th>{t('marginPercent')}</th>
    </>
  );
  return (
    <ReportView<ShipmentProfitabilityDto>
      id="shipment-profitability"
      permission="shipment_profitability:view"
      title={t('profitability')}
      hint={t('profitabilityHint')}
      filters={{ dates: 'period', customer: true }}
    >
      {(r) => (
        <div className="stack">
          <ReportTable title={t('byCustomer')}>
            <thead>
              <tr>
                <th>{t('customer')}</th>
                <th>{t('shipmentCount')}</th>
                {figureHeads}
              </tr>
            </thead>
            <tbody>
              {r.customers.length === 0 && <EmptyRow columns={6} text={t('noLines')} />}
              {r.customers.map((c) => (
                <tr key={c.customerId}>
                  <td>{c.customerName}</td>
                  <td dir="ltr">{c.shipments}</td>
                  {figures(c)}
                </tr>
              ))}
              <tr className="subtotal">
                <td>{t('total')}</td>
                <td dir="ltr">{r.shipments.length}</td>
                {figures(r.totals, true)}
              </tr>
            </tbody>
          </ReportTable>
          <ReportTable title={t('byRoute')}>
            <thead>
              <tr>
                <th>{t('origin')}</th>
                <th>{t('destination')}</th>
                <th>{t('shipmentCount')}</th>
                {figureHeads}
              </tr>
            </thead>
            <tbody>
              {r.routes.length === 0 && <EmptyRow columns={7} text={t('noLines')} />}
              {r.routes.map((x) => (
                <tr key={`${x.origin.id}-${x.destination.id}`}>
                  <td>{place(x.origin)}</td>
                  <td>{place(x.destination)}</td>
                  <td dir="ltr">{x.shipments}</td>
                  {figures(x)}
                </tr>
              ))}
            </tbody>
          </ReportTable>
          <ReportTable title={t('shipments')}>
            <thead>
              <tr>
                <th>{t('shipment')}</th>
                <th>{t('customer')}</th>
                <th>{t('route')}</th>
                {figureHeads}
              </tr>
            </thead>
            <tbody>
              {r.shipments.length === 0 && <EmptyRow columns={7} text={t('noLines')} />}
              {r.shipments.map((s) => (
                <tr key={s.shipmentId}>
                  <td dir="ltr">
                    <Link href={`/shipments/${s.shipmentId}`}>{s.number}</Link>
                  </td>
                  <td>{s.customerName}</td>
                  <td className="nowrap">
                    {s.origin.code} → {s.destination.code}
                  </td>
                  {figures(s)}
                </tr>
              ))}
            </tbody>
          </ReportTable>
        </div>
      )}
    </ReportView>
  );
}

export function InvoicesReceipts() {
  const t = useTranslations('Reports');
  const te = useTranslations('Enums');
  return (
    <ReportView<InvoicesReceiptsDto>
      id="invoices-receipts"
      permission="financial_reports:view"
      title={t('invoicesReceipts')}
      hint={t('invoicesReceiptsHint')}
      filters={{ dates: 'period', customer: true }}
    >
      {(r) => (
        <div className="stack">
          <ReportTable title={t('invoices')}>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('date')}</th>
                <th>{t('customer')}</th>
                <th>{t('shipment')}</th>
                <th>{t('amount')}</th>
                <th>{t('totalUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {r.invoices.length === 0 && <EmptyRow columns={6} text={t('noLines')} />}
              {r.invoices.map((i) => (
                <tr key={i.invoiceId}>
                  <td dir="ltr">
                    <Link href={`/invoices/${i.invoiceId}`}>{i.number}</Link>
                  </td>
                  <td dir="ltr">{i.invoiceDate}</td>
                  <td>{i.customerName}</td>
                  <td dir="ltr">{i.shipmentNumber}</td>
                  <td dir="ltr">
                    <Money value={i.total} currency={i.currency} />
                  </td>
                  <AmountCell value={i.totalUsd} />
                </tr>
              ))}
              <tr className="subtotal">
                <td colSpan={5}>{t('total')}</td>
                <AmountCell value={r.totalInvoicedUsd} strong />
              </tr>
            </tbody>
          </ReportTable>
          <ReportTable title={t('receipts')}>
            <thead>
              <tr>
                <th>{t('number')}</th>
                <th>{t('date')}</th>
                <th>{t('customer')}</th>
                <th>{t('status')}</th>
                <th>{t('amount')}</th>
                <th>{t('amountUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {r.receipts.length === 0 && <EmptyRow columns={6} text={t('noLines')} />}
              {r.receipts.map((x) => (
                <tr key={x.receiptId} className={x.status === 'CANCELLED' ? 'inactive' : undefined}>
                  <td dir="ltr">
                    <Link href={`/receipts/${x.receiptId}`}>{x.number}</Link>
                  </td>
                  <td dir="ltr">{x.receiptDate}</td>
                  <td>{x.customerName}</td>
                  <td>{te(`receipt_${x.status}`)}</td>
                  <td dir="ltr">
                    <Money value={x.amount} currency={x.currency} />
                  </td>
                  <AmountCell value={x.amountUsd} />
                </tr>
              ))}
              <tr className="subtotal">
                <td colSpan={5}>{t('totalReceived')}</td>
                <AmountCell value={r.totalReceivedUsd} strong />
              </tr>
            </tbody>
          </ReportTable>
        </div>
      )}
    </ReportView>
  );
}

export function CashMovement() {
  const t = useTranslations('Reports');
  const name = useLocalName();
  return (
    <ReportView<CashMovementDto>
      id="cash-movement"
      permission="financial_reports:view"
      title={t('cashMovement')}
      hint={t('cashMovementHint')}
      filters={{ dates: 'period', cashAccount: true }}
    >
      {(r) => (
        <div className="stack">
          <ReportTable title={t('cashAccounts')}>
            <thead>
              <tr>
                <th>{t('account')}</th>
                <th>{t('opening')}</th>
                <th>{t('inflow')}</th>
                <th>{t('outflow')}</th>
                <th>{t('closing')}</th>
                <th>{t('closingUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {r.accounts.length === 0 && <EmptyRow columns={6} text={t('noLines')} />}
              {r.accounts.map((a) => {
                const currency = a.currency ?? undefined;
                return (
                  <tr key={a.accountId}>
                    <td>
                      <span dir="ltr">{a.code}</span> · {name(a)}
                    </td>
                    <td dir="ltr">
                      <Money value={a.opening} currency={currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={a.inflow} currency={currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={a.outflow} currency={currency} />
                    </td>
                    <td dir="ltr">
                      <Money value={a.closing} currency={currency} />
                    </td>
                    <AmountCell value={a.closingUsd} />
                  </tr>
                );
              })}
              <tr className="subtotal">
                <td colSpan={5}>{t('totalUsdClosing')}</td>
                <AmountCell value={r.totals.closingUsd} strong />
              </tr>
            </tbody>
          </ReportTable>
          <ReportTable title={t('fxDifferences')}>
            <thead>
              <tr>
                <th>{t('date')}</th>
                <th>{t('entry')}</th>
                <th>{t('description')}</th>
                <th>{t('amountUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {r.fx.lines.length === 0 && <EmptyRow columns={4} text={t('noFx')} />}
              {r.fx.lines.map((l) => (
                <tr key={`${l.entryId}-${l.branchCode}`}>
                  <td dir="ltr">{l.entryDate}</td>
                  <td dir="ltr">
                    <Link href={`/accounting/journals/${l.entryId}`}>{l.entryNumber}</Link>
                  </td>
                  <td>{l.description}</td>
                  <AmountCell value={l.amountUsd} />
                </tr>
              ))}
              <tr className="subtotal">
                <td colSpan={3}>{t('fxGain')}</td>
                <AmountCell value={r.fx.gainUsd} />
              </tr>
              <tr className="subtotal">
                <td colSpan={3}>{t('fxLoss')}</td>
                <AmountCell value={r.fx.lossUsd} />
              </tr>
              <tr className="subtotal">
                <td colSpan={3}>{t('fxNet')}</td>
                <AmountCell value={r.fx.netUsd} strong />
              </tr>
            </tbody>
          </ReportTable>
        </div>
      )}
    </ReportView>
  );
}

export function OpenAccruals() {
  const t = useTranslations('Reports');
  const name = useLocalName();
  return (
    <ReportView<OpenAccrualsDto>
      id="open-accruals"
      permission="financial_reports:view"
      title={t('openAccruals')}
      hint={t('openAccrualsHint')}
      filters={{ dates: 'asOf' }}
    >
      {(r) => (
        <div className="stack">
          <dl className="details">
            <dt>{t('accruedTotal')}</dt>
            <dd>
              <Money value={r.accruedTotalUsd} currency="USD" />
              {r.accruedAccount && (
                <span className="muted">
                  {' '}
                  · <span dir="ltr">{r.accruedAccount.code}</span> {name(r.accruedAccount)}
                </span>
              )}
            </dd>
            <dt>{t('otherAccrued')}</dt>
            <dd>
              <Money value={r.otherAccruedUsd} currency="USD" />
            </dd>
            <dt>{t('clearingBalance')}</dt>
            <dd>
              <Money value={r.clearingBalanceUsd} currency="USD" />
              {r.clearingAccount && (
                <span className="muted">
                  {' '}
                  · <span dir="ltr">{r.clearingAccount.code}</span> {name(r.clearingAccount)}
                </span>
              )}
            </dd>
          </dl>
          <ReportTable title={t('trips')}>
            <thead>
              <tr>
                <th>{t('trip')}</th>
                <th>{t('carrier')}</th>
                <th>{t('completedOn')}</th>
                <th>{t('accrued')}</th>
                <th>{t('balanceUsd')}</th>
              </tr>
            </thead>
            <tbody>
              {r.trips.length === 0 && <EmptyRow columns={5} text={t('nothingOpen')} />}
              {r.trips.map((x) => (
                <tr key={x.tripId}>
                  <td dir="ltr">
                    <Link href={`/trips/${x.tripId}`}>{x.tripNumber}</Link>
                  </td>
                  <td>{x.carrierName ?? '—'}</td>
                  <td dir="ltr">{x.completedAt ?? '—'}</td>
                  <td dir="ltr">
                    <Money value={x.balance} currency={x.currency} />
                  </td>
                  <AmountCell value={x.balanceUsd} />
                </tr>
              ))}
              <tr className="subtotal">
                <td colSpan={4}>{t('total')}</td>
                <AmountCell value={r.tripsTotalUsd} strong />
              </tr>
            </tbody>
          </ReportTable>
        </div>
      )}
    </ReportView>
  );
}
