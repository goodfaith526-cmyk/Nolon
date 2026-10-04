'use client';

import type { Permission } from '@nolon/shared';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { can, useMe } from '../../StaffShell';

const REPORTS: readonly {
  href: string;
  title:
    | 'trialBalance'
    | 'incomeStatement'
    | 'balanceSheet'
    | 'generalLedger'
    | 'arAging'
    | 'profitability'
    | 'invoicesReceipts'
    | 'cashMovement'
    | 'openAccruals';
  permission: Permission;
}[] = [
  {
    href: '/reports/income-statement',
    title: 'incomeStatement',
    permission: 'financial_reports:view',
  },
  { href: '/reports/balance-sheet', title: 'balanceSheet', permission: 'financial_reports:view' },
  {
    href: '/accounting/trial-balance',
    title: 'trialBalance',
    permission: 'financial_reports:view',
  },
  { href: '/reports/general-ledger', title: 'generalLedger', permission: 'financial_reports:view' },
  { href: '/reports/ar-aging', title: 'arAging', permission: 'financial_reports:view' },
  {
    href: '/reports/shipment-profitability',
    title: 'profitability',
    permission: 'shipment_profitability:view',
  },
  {
    href: '/reports/invoices-receipts',
    title: 'invoicesReceipts',
    permission: 'financial_reports:view',
  },
  { href: '/reports/cash-movement', title: 'cashMovement', permission: 'financial_reports:view' },
  { href: '/reports/open-accruals', title: 'openAccruals', permission: 'financial_reports:view' },
];

/** The financial reports the user may open, each with what it shows. */
export function ReportsIndex() {
  const t = useTranslations('Reports');
  const tc = useTranslations('Common');
  const me = useMe();
  const reports = REPORTS.filter((r) => can(me, r.permission));
  if (reports.length === 0) return <p className="error">{tc('noAccess')}</p>;
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>{t('title')}</h1>
          <p className="muted">{t('intro')}</p>
        </div>
      </div>
      <div className="grid report-cards">
        {reports.map((r) => (
          <Link key={r.href} href={r.href} className="report-card">
            <strong>{t(r.title)}</strong>
            <span className="muted">{t(`${r.title}Hint`)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
