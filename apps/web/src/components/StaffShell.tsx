'use client';

import type { AuthMeResponse, Locale, Permission } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import Image from 'next/image';
import { type ReactNode, createContext, use, useEffect, useState } from 'react';
import logoAr from '@/assets/brand/logo-ar.webp';
import logoEn from '@/assets/brand/logo-en.webp';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { ApiError, api } from '@/lib/api';
import { icons } from './Icons';

interface NavLink {
  href: string;
  label:
    | 'home'
    | 'customers'
    | 'rates'
    | 'quotations'
    | 'bookings'
    | 'shipments'
    | 'warehouses'
    | 'trips'
    | 'vehicles'
    | 'drivers'
    | 'carriers'
    | 'invoices'
    | 'receipts'
    | 'creditNotes'
    | 'suppliers'
    | 'supplierBills'
    | 'supplierPayments'
    | 'expenses'
    | 'openingBalances'
    | 'journals'
    | 'trialBalance'
    | 'reports'
    | 'operationalReports'
    | 'managementDashboard'
    | 'branchDashboard'
    | 'chartOfAccounts'
    | 'fxRates'
    | 'periods'
    | 'users';
  icon: keyof typeof icons;
  permission?: Permission;
}

const NAV_SECTIONS: readonly {
  title?: 'commercial' | 'operations' | 'finance' | 'admin';
  links: readonly NavLink[];
}[] = [
  {
    links: [
      { href: '/dashboard', label: 'home', icon: 'home' },
      {
        href: '/dashboard/management',
        label: 'managementDashboard',
        icon: 'balance',
        permission: 'dashboards:view',
      },
      {
        href: '/dashboard/branch',
        label: 'branchDashboard',
        icon: 'calendar',
        permission: 'dashboards:view',
      },
    ],
  },
  {
    title: 'commercial',
    links: [
      { href: '/customers', label: 'customers', icon: 'customers', permission: 'customers:view' },
      { href: '/rates', label: 'rates', icon: 'rates', permission: 'rates:view' },
      {
        href: '/quotations',
        label: 'quotations',
        icon: 'quotations',
        permission: 'quotations:view',
      },
      { href: '/bookings', label: 'bookings', icon: 'bookings', permission: 'bookings:view' },
    ],
  },
  {
    title: 'operations',
    links: [
      { href: '/shipments', label: 'shipments', icon: 'ship', permission: 'shipments:view' },
      { href: '/trips', label: 'trips', icon: 'truck', permission: 'transport_trips:view' },
      {
        href: '/transport/vehicles',
        label: 'vehicles',
        icon: 'vehicle',
        permission: 'transport_fleet:view',
      },
      {
        href: '/transport/drivers',
        label: 'drivers',
        icon: 'driver',
        permission: 'transport_fleet:view',
      },
      {
        href: '/transport/carriers',
        label: 'carriers',
        icon: 'carrier',
        permission: 'transport_fleet:view',
      },
      {
        href: '/warehouses',
        label: 'warehouses',
        icon: 'warehouse',
        permission: 'warehouse:view',
      },
      {
        href: '/operational-reports',
        label: 'operationalReports',
        icon: 'report',
        permission: 'operational_reports:view',
      },
    ],
  },
  {
    title: 'finance',
    links: [
      {
        href: '/invoices',
        label: 'invoices',
        icon: 'invoice',
        permission: 'customer_invoices:view',
      },
      { href: '/receipts', label: 'receipts', icon: 'receipt', permission: 'receipts:view' },
      {
        href: '/credit-notes',
        label: 'creditNotes',
        icon: 'invoice',
        permission: 'credit_notes:view',
      },
      { href: '/suppliers', label: 'suppliers', icon: 'carrier', permission: 'suppliers:view' },
      {
        href: '/supplier-bills',
        label: 'supplierBills',
        icon: 'invoice',
        permission: 'suppliers:view',
      },
      {
        href: '/supplier-payments',
        label: 'supplierPayments',
        icon: 'receipt',
        permission: 'supplier_payments:view',
      },
      { href: '/expenses', label: 'expenses', icon: 'receipt', permission: 'expenses:view' },
      {
        href: '/accounting/journals',
        label: 'journals',
        icon: 'journal',
        permission: 'manual_journals:view',
      },
      {
        href: '/accounting/trial-balance',
        label: 'trialBalance',
        icon: 'balance',
        permission: 'financial_reports:view',
      },
      {
        href: '/reports',
        label: 'reports',
        icon: 'report',
        permission: 'financial_reports:view',
      },
      {
        href: '/accounting/accounts',
        label: 'chartOfAccounts',
        icon: 'accounts',
        permission: 'chart_of_accounts:view',
      },
      {
        href: '/accounting/fx-rates',
        label: 'fxRates',
        icon: 'exchange',
        permission: 'fx_rates:view',
      },
      {
        href: '/accounting/periods',
        label: 'periods',
        icon: 'calendar',
        permission: 'chart_of_accounts:view',
      },
      {
        href: '/accounting/opening-balances',
        label: 'openingBalances',
        icon: 'balance',
        permission: 'manual_journals:approve',
      },
    ],
  },
  {
    title: 'admin',
    links: [{ href: '/users', label: 'users', icon: 'users', permission: 'users:view' }],
  },
];

/** The signed-in user; provided by StaffShell and by the printouts' PrintShell. */
export const MeContext = createContext<AuthMeResponse | null>(null);

/** The signed-in user, as /auth/me returned it. Only inside StaffShell or PrintShell. */
export function useMe(): AuthMeResponse {
  const me = use(MeContext);
  if (!me) throw new Error('useMe outside StaffShell');
  return me;
}

/** Shows UI only; the API enforces every permission on its own. */
export function can(me: AuthMeResponse, permission: Permission): boolean {
  return me.permissions.includes(permission);
}

/** Loads the session for every staff page; sends the visitor to sign-in when there is none. */
export function StaffShell({ children }: { children: ReactNode }) {
  const t = useTranslations('Shell');
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<AuthMeResponse>('/auth/me')
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
        else setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  async function signOut() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
    }
  }

  if (failed) return <p className="page error">{t('loadFailed')}</p>;
  if (!me) return <p className="page muted loading">{t('loading')}</p>;

  const otherLocale: Locale = locale === 'ar' ? 'en' : 'ar';
  const isActive = (href: string) =>
    href === '/dashboard' ? pathname === href : pathname.startsWith(href);

  return (
    <MeContext value={me}>
      <div className={menuOpen ? 'app menu-open' : 'app'}>
        <aside className="sidebar" aria-label={t('menu')}>
          <Link href="/dashboard" className="sidebar-logo" onClick={() => setMenuOpen(false)}>
            <Image
              src={locale === 'ar' ? logoAr : logoEn}
              alt="NOLON"
              width={150}
              priority
              unoptimized
            />
          </Link>
          <nav className="sidebar-nav">
            {NAV_SECTIONS.map((section, index) => {
              const links = section.links.filter((l) => !l.permission || can(me, l.permission));
              if (links.length === 0) return null;
              return (
                <div key={section.title ?? index} className="nav-section">
                  {section.title && <p className="nav-title">{t(section.title)}</p>}
                  {links.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      className={isActive(l.href) ? 'nav-link active' : 'nav-link'}
                      aria-current={isActive(l.href) ? 'page' : undefined}
                      onClick={() => setMenuOpen(false)}
                    >
                      {icons[l.icon]}
                      <span>{t(l.label)}</span>
                    </Link>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="sidebar-foot">
            <Link
              href="/account"
              className={isActive('/account') ? 'nav-link active' : 'nav-link'}
              onClick={() => setMenuOpen(false)}
            >
              {icons.account}
              <span>{t('account')}</span>
            </Link>
          </div>
        </aside>
        <button
          type="button"
          className="scrim"
          aria-label={t('closeMenu')}
          onClick={() => setMenuOpen(false)}
        />
        <div className="main">
          <header className="topbar">
            <button
              type="button"
              className="icon-button menu-button"
              aria-label={t('menu')}
              onClick={() => setMenuOpen(true)}
            >
              {icons.menu}
            </button>
            <div className="topbar-user">
              <span className="avatar" aria-hidden="true">
                {me.fullName.trim().charAt(0).toUpperCase()}
              </span>
              <span className="topbar-name">
                <strong>{me.fullName}</strong>
                <span className="muted">
                  {me.allBranches ? t('allBranches') : me.branches.map((b) => b.code).join(' · ')}
                </span>
              </span>
            </div>
            <div className="topbar-actions">
              <Link href={pathname} locale={otherLocale} className="button ghost">
                {icons.globe}
                <span>{t('switchLocale')}</span>
              </Link>
              <button type="button" className="ghost" onClick={() => void signOut()}>
                {icons.signOut}
                <span>{t('signOut')}</span>
              </button>
            </div>
          </header>
          <main className="page">{children}</main>
        </div>
      </div>
    </MeContext>
  );
}
