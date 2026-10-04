'use client';

import type {
  CustomerSummaryDto,
  OperationalReport,
  Page,
  Permission,
  ReportAccountOptionDto,
  ReportBranchDto,
} from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link } from '@/i18n/navigation';
import { api } from '@/lib/api';
import { field } from '@/lib/form';
import { useLocalName } from '@/lib/master-data';
import { todayString } from '@/lib/money';
import { Notice, type NoticeState, useFailureText } from '../../commercial/Notice';
import { can, useMe } from '../../StaffShell';
import { Money } from '../common';

/** The report ids of the API (`/reports/<id>`) that have a page here. */
export type ReportId =
  | 'trial-balance'
  | 'income-statement'
  | 'balance-sheet'
  | 'general-ledger'
  | 'ar-aging'
  | 'shipment-profitability'
  | 'invoices-receipts'
  | 'cash-movement'
  | 'open-accruals'
  | OperationalReport;

/** A report's own select filter (status, warehouse, vehicle...), sent as `name=value`. */
export interface ExtraFilter {
  name: string;
  label: string;
  /** The empty choice: no filter. */
  all: string;
  options: readonly { value: string; label: string }[];
}

/** Which filters a report has besides the branch. */
export interface FilterSet {
  /** A period, a single date, or none (a report of now). */
  dates: 'period' | 'asOf' | 'none';
  customer?: boolean;
  /** One or more accounts (general ledger). */
  accounts?: boolean;
  /** One optional cash or bank account. */
  cashAccount?: boolean;
  extras?: readonly ExtraFilter[];
}

export interface Filters {
  from: string;
  to: string;
  asOf: string;
  branchId: string;
  customerId: string;
  accountIds: string[];
  /** Values of the report's own filters, by name. */
  extra: Readonly<Record<string, string>>;
}

/** The query string the API takes for these filters (without the locale). */
export function reportQuery(set: FilterSet, f: Filters): string {
  const q = new URLSearchParams();
  if (set.dates === 'period') {
    q.set('from', f.from);
    q.set('to', f.to);
  } else if (set.dates === 'asOf') {
    q.set('asOf', f.asOf);
  }
  if (f.branchId) q.set('branchId', f.branchId);
  if (set.customer && f.customerId) q.set('customerId', f.customerId);
  if (set.accounts) q.set('accountIds', f.accountIds.join(','));
  if (set.cashAccount && f.accountIds[0]) q.set('accountId', f.accountIds[0]);
  for (const extra of set.extras ?? []) {
    const value = f.extra[extra.name];
    if (value) q.set(extra.name, value);
  }
  return q.toString();
}

function firstOfMonth(today: string): string {
  return `${today.slice(0, 8)}01`;
}

/**
 * A report page: title, filters (period or date, branch, and the report's own), an Excel export of
 * what is shown, and the report itself, drawn by `children` once loaded. The API checks every
 * permission and branch; this only hides what the user cannot use.
 */
export function ReportView<T>({
  id,
  permission,
  title,
  hint,
  filters: set,
  back,
  children,
}: {
  id: ReportId;
  /** Every permission the report needs. */
  permission: Permission | readonly Permission[];
  title: string;
  hint: string;
  filters: FilterSet;
  /** The list this report is opened from (default: the financial reports). */
  back?: { href: string; label: string };
  children: (report: T, filters: Filters) => ReactNode;
}) {
  const t = useTranslations('Reports');
  const tc = useTranslations('Common');
  const tp = useTranslations('Print');
  const me = useMe();
  const locale = useLocale();
  const name = useLocalName();
  const failure = useFailureText();
  const [filters, setFilters] = useState<Filters>(() => {
    const today = todayString();
    return {
      from: firstOfMonth(today),
      to: today,
      asOf: today,
      // Users limited to their branches pick one of them; "all" is for all-branch roles.
      branchId: me.allBranches ? '' : (me.branches[0]?.id ?? ''),
      customerId: '',
      accountIds: [],
      extra: {},
    };
  });
  const [report, setReport] = useState<{ query: string; data: T } | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const customers = useCustomerOptions(Boolean(set.customer) && can(me, 'customers:view'));
  const accounts = useAccountOptions(Boolean(set.accounts || set.cashAccount));

  const allowed = (typeof permission === 'string' ? [permission] : permission).every((p) =>
    can(me, p),
  );
  const ready = !set.accounts || filters.accountIds.length > 0;
  const query = reportQuery(set, filters);

  useEffect(() => {
    if (!allowed || !ready) return;
    let cancelled = false;
    api<T>(`/reports/${id}?${query}`)
      .then((data) => {
        if (!cancelled) setReport({ query, data });
      })
      .catch((e: unknown) => {
        if (!cancelled) setNotice({ ok: false, text: failure(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, ready, id, query, failure]);

  if (!allowed) return <p className="error">{tc('noAccess')}</p>;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const today = todayString();
    setNotice(null);
    setFilters({
      from: field(form, 'from') || firstOfMonth(today),
      to: field(form, 'to') || today,
      asOf: field(form, 'asOf') || today,
      branchId: field(form, 'branchId'),
      customerId: field(form, 'customerId'),
      accountIds: form
        .getAll('accountId')
        .filter((v): v is string => typeof v === 'string' && v !== ''),
      extra: Object.fromEntries((set.extras ?? []).map((x) => [x.name, field(form, x.name)])),
    });
  }

  const shown = report?.query === query ? report.data : null;
  const exportHref = `/api/v1/reports/${id}/export?${query}&locale=${locale}`;
  const accountChoices = (accounts ?? []).filter((a) => !set.cashAccount || a.isCash);
  const branchLabel = (id: string) => {
    const branch = me.branches.find((b) => b.id === id);
    return branch ? `${branch.code} · ${name(branch)}` : t('allBranches');
  };

  return (
    <section className="stack report">
      <div className="page-head">
        <div>
          <Link href={back?.href ?? '/reports'} className="back-link">
            {back?.label ?? t('allReports')}
          </Link>
          <h1>{title}</h1>
          <p className="muted">{hint}</p>
        </div>
        {ready && (
          <div className="actions">
            <button type="button" onClick={() => window.print()}>
              {tp('printPdf')}
            </button>
            <a className="button" href={exportHref} download>
              {t('exportExcel')}
            </a>
          </div>
        )}
      </div>
      <ReportPrintHead
        entries={[
          ...(set.dates === 'period'
            ? ([
                [t('from'), filters.from],
                [t('to'), filters.to],
              ] as const)
            : set.dates === 'asOf'
              ? ([[t('asOf'), filters.asOf]] as const)
              : []),
          [t('branch'), branchLabel(filters.branchId)],
          ...(set.customer
            ? ([
                [
                  t('customer'),
                  customers?.find((c) => c.id === filters.customerId)?.name ??
                    (filters.customerId ? '…' : t('allCustomers')),
                ],
              ] as const)
            : []),
          ...(set.accounts || set.cashAccount
            ? ([
                [
                  set.cashAccount ? t('cashAccount') : t('accounts'),
                  filters.accountIds.length === 0
                    ? t('allCashAccounts')
                    : filters.accountIds
                        .map((id) => accountChoices.find((a) => a.accountId === id)?.code ?? '…')
                        .join(', '),
                ],
              ] as const)
            : []),
          ...(set.extras ?? []).map(
            (x) =>
              [
                x.label,
                x.options.find((o) => o.value === filters.extra[x.name])?.label ?? x.all,
              ] as const,
          ),
        ]}
      />
      <Notice notice={notice} />
      <form className="row report-filters" onSubmit={onSubmit}>
        {set.dates === 'period' ? (
          <>
            <label className="field">
              <span>{t('from')}</span>
              <input type="date" name="from" required defaultValue={filters.from} />
            </label>
            <label className="field">
              <span>{t('to')}</span>
              <input type="date" name="to" required defaultValue={filters.to} />
            </label>
          </>
        ) : set.dates === 'asOf' ? (
          <label className="field">
            <span>{t('asOf')}</span>
            <input type="date" name="asOf" required defaultValue={filters.asOf} />
          </label>
        ) : null}
        <label className="field">
          <span>{t('branch')}</span>
          <select name="branchId" defaultValue={filters.branchId}>
            {me.allBranches && <option value="">{t('allBranches')}</option>}
            {me.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {name(b)}
              </option>
            ))}
          </select>
        </label>
        {set.customer && customers && (
          <label className="field">
            <span>{t('customer')}</span>
            <select name="customerId" defaultValue={filters.customerId}>
              <option value="">{t('allCustomers')}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {set.cashAccount && (
          <label className="field">
            <span>{t('cashAccount')}</span>
            <select name="accountId" defaultValue={filters.accountIds[0] ?? ''}>
              <option value="">{t('allCashAccounts')}</option>
              {accountChoices.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.code} · {name(a)}
                </option>
              ))}
            </select>
          </label>
        )}
        {set.extras?.map((x) => (
          <label key={x.name} className="field">
            <span>{x.label}</span>
            <select name={x.name} defaultValue={filters.extra[x.name] ?? ''}>
              <option value="">{x.all}</option>
              {x.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {set.accounts && (
          <label className="field wide">
            <span>{t('accounts')}</span>
            <select name="accountId" multiple size={5} defaultValue={filters.accountIds}>
              {accountChoices.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.code} · {name(a)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className="primary">
          {t('show')}
        </button>
      </form>
      {!ready ? (
        <p className="muted">{t('chooseAccounts')}</p>
      ) : shown === null ? (
        notice === null && <p className="muted">{tc('loading')}</p>
      ) : (
        children(shown, filters)
      )}
    </section>
  );
}

/**
 * On paper only: the company, the filters the report was run with (as a header, since the filter
 * form is not printed), who printed it and when, and A4 landscape pages.
 */
export function ReportPrintHead({ entries }: { entries: readonly (readonly [string, string])[] }) {
  const tp = useTranslations('Print');
  const locale = useLocale();
  const me = useMe();
  const [printedAt] = useState(() =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()),
  );
  return (
    <div className="print-only report-print-head">
      <style>{'@media print { @page { size: A4 landscape; margin: 10mm; } }'}</style>
      <strong>{tp('company')}</strong>
      <dl aria-label={tp('reportFilters')}>
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd dir="auto">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">{tp('printedBy', { name: me.fullName, at: printedAt })}</p>
    </div>
  );
}

function useCustomerOptions(enabled: boolean): CustomerSummaryDto[] | null {
  const [customers, setCustomers] = useState<CustomerSummaryDto[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api<Page<CustomerSummaryDto>>('/customers?pageSize=100')
      .then((page) => {
        if (!cancelled) setCustomers(page.items);
      })
      .catch(() => {
        // Without the list the report still runs for every customer.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return customers;
}

/** A list the API gives (warehouses, vehicles...), for a filter; null until loaded or when off. */
export function useApiList<T>(path: string, enabled: boolean): T[] | null {
  const [list, setList] = useState<T[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api<T[]>(path)
      .then((items) => {
        if (!cancelled) setList(items);
      })
      .catch(() => {
        // Without the list the filter offers only "all"; the report itself still runs.
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);
  return list;
}

function useAccountOptions(enabled: boolean): ReportAccountOptionDto[] | null {
  const [accounts, setAccounts] = useState<ReportAccountOptionDto[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api<ReportAccountOptionDto[]>('/reports/accounts')
      .then((list) => {
        if (!cancelled) setAccounts(list);
      })
      .catch(() => {
        // The account filter stays empty; the API reports any problem with the report itself.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return accounts;
}

/** An amount cell: always left to right, digits grouped. */
export function AmountCell({ value, strong }: { value: string | null; strong?: boolean }) {
  const content = value === null ? '—' : <Money value={value} />;
  return <td dir="ltr">{strong ? <strong>{content}</strong> : content}</td>;
}

/** Table heading cells for one amount column per branch, then the total. */
export function BranchHeads({ branches, total }: { branches: ReportBranchDto[]; total: string }) {
  return (
    <>
      {branches.map((b) => (
        <th key={b.id} dir="ltr">
          {b.code}
        </th>
      ))}
      <th>{total}</th>
    </>
  );
}

/** A table in a panel that scrolls sideways on a phone; `title` heads the panel. */
export function ReportTable({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="panel">
      {title && (
        <div className="panel-head">
          <h2>{title}</h2>
        </div>
      )}
      <div className="table-scroll">
        <table>{children}</table>
      </div>
    </div>
  );
}

/** A row for an empty table, spanning its columns. */
export function EmptyRow({ columns, text }: { columns: number; text: string }) {
  return (
    <tr>
      <td colSpan={columns} className="empty">
        {text}
      </td>
    </tr>
  );
}
