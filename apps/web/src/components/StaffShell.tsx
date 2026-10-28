'use client';

import type { AuthMeResponse, Locale, Permission } from '@nolon/shared';
import { useLocale, useTranslations } from 'next-intl';
import Image from 'next/image';
import { type ReactNode, createContext, use, useEffect, useRef, useState } from 'react';
import logoAr from '@/assets/brand/logo-ar.webp';
import logoEn from '@/assets/brand/logo-en.webp';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { ApiError, api } from '@/lib/api';
import { assistantPageUrl } from '@/lib/assistant-page';
import { useMediaQuery } from '@/lib/media-query';
import { useFoldedSections } from '@/lib/nav-folds';
import { AlertsBell } from './alerts/Alerts';
import { AssistantPanel } from './AssistantPanel';
import { DRAFT_VIEW_PERMISSIONS } from './drafts/draft-kinds';
import { icons } from './Icons';

interface NavLink {
  href: string;
  label:
    | 'home'
    | 'customers'
    | 'partners'
    | 'rates'
    | 'quotations'
    | 'bookings'
    | 'shipments'
    | 'warehouses'
    | 'trips'
    | 'consolidations'
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
    | 'reports'
    | 'operationalReports'
    | 'managementDashboard'
    | 'branchDashboard'
    | 'chartOfAccounts'
    | 'fxRates'
    | 'periods'
    | 'locations'
    | 'masterData'
    | 'users'
    | 'permissions'
    | 'branchPermissions'
    | 'alertSettings'
    | 'apiKeys'
    | 'assistantDrafts'
    | 'botRequests';
  icon: keyof typeof icons;
  /** Shown with this permission, or with any of these. */
  permission?: Permission | readonly Permission[];
  /** Shown to a person holding a live delegation (plan 03), whatever their permissions. */
  delegates?: true;
}

type SectionTitle = 'commercial' | 'operations' | 'fleet' | 'finance' | 'insights' | 'settings';

const SECTION_TITLES: readonly SectionTitle[] = [
  'commercial',
  'operations',
  'fleet',
  'finance',
  'insights',
  'settings',
];

/** Sections that start folded until the user opens them (less used day to day). */
const FOLDED_BY_DEFAULT: readonly SectionTitle[] = ['fleet', 'settings'];

const NAV_SECTIONS: readonly {
  title?: SectionTitle;
  links: readonly NavLink[];
}[] = [
  {
    links: [{ href: '/dashboard', label: 'home', icon: 'home' }],
  },
  {
    title: 'commercial',
    links: [
      {
        href: '/drafts',
        label: 'assistantDrafts',
        icon: 'assistant',
        permission: DRAFT_VIEW_PERMISSIONS,
      },
      {
        href: '/cs-booking-requests',
        label: 'botRequests',
        icon: 'assistant',
        permission: [
          'cs_booking_requests:view',
          'cs_booking_requests:update',
          'cs_booking_requests:approve',
        ],
      },
      { href: '/customers', label: 'customers', icon: 'customers', permission: 'customers:view' },
      { href: '/partners', label: 'partners', icon: 'carrier', permission: 'partners:view' },
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
      {
        href: '/consolidations',
        label: 'consolidations',
        icon: 'ship',
        permission: 'consolidation:view',
      },
      { href: '/trips', label: 'trips', icon: 'truck', permission: 'transport_trips:view' },
      {
        href: '/warehouses',
        label: 'warehouses',
        icon: 'warehouse',
        permission: 'warehouse:view',
      },
    ],
  },
  {
    title: 'fleet',
    links: [
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
    ],
  },
  {
    title: 'insights',
    links: [
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
      {
        href: '/operational-reports',
        label: 'operationalReports',
        icon: 'report',
        permission: 'operational_reports:view',
      },
      {
        href: '/reports',
        label: 'reports',
        icon: 'report',
        permission: 'financial_reports:view',
      },
    ],
  },
  {
    title: 'settings',
    links: [
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
      {
        href: '/locations',
        label: 'locations',
        icon: 'globe',
        permission: 'master_data:view',
      },
      {
        href: '/master-data',
        label: 'masterData',
        icon: 'accounts',
        permission: 'master_data:view',
      },
      {
        href: '/alerts/settings',
        label: 'alertSettings',
        icon: 'bell',
        permission: 'alert_settings:view',
      },
      { href: '/users', label: 'users', icon: 'users', permission: 'users:view' },
      {
        href: '/permissions',
        label: 'permissions',
        icon: 'shield',
        permission: 'access_control:view',
      },
      { href: '/branch-permissions', label: 'branchPermissions', icon: 'shield', delegates: true },
      { href: '/api-keys', label: 'apiKeys', icon: 'accounts', permission: 'users:view' },
    ],
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

function canSee(me: AuthMeResponse, link: NavLink): boolean {
  if (link.delegates) return (me.delegations?.length ?? 0) > 0;
  const { permission } = link;
  if (permission === undefined) return true;
  if (typeof permission === 'string') return can(me, permission);
  return permission.some((p) => can(me, p));
}

/** Loads the session for every staff page; sends the visitor to sign-in when there is none. */
export function StaffShell({ children }: { children: ReactNode }) {
  const t = useTranslations('Shell');
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const [folded, toggleSection] = useFoldedSections(SECTION_TITLES, FOLDED_BY_DEFAULT);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [failed, setFailed] = useState(false);
  // The assistant panel: loaded on first open, then kept (hidden when closed) so its work survives.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantLoaded, setAssistantLoaded] = useState(false);

  const assistantToggle = useRef<HTMLButtonElement>(null);
  const assistantReturn = useRef(false);
  // Below this width the open panel lies over the page instead of beside it (globals.css), so it
  // acts as a dialog: the page behind is inert until it closes. Wider, both stay usable.
  const assistantCovers = useMediaQuery('(max-width: 1099px)');
  const pageInert = assistantOpen && assistantCovers;

  function toggleAssistant() {
    setAssistantLoaded(true);
    setAssistantOpen((value) => !value);
  }

  function closeAssistant() {
    assistantReturn.current = true;
    setAssistantOpen(false);
  }

  // Closed from inside the panel: the keyboard goes back to the button that opened it, once the
  // page behind is no longer inert.
  useEffect(() => {
    if (assistantOpen || !assistantReturn.current) return;
    assistantReturn.current = false;
    assistantToggle.current?.focus();
  }, [assistantOpen]);

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
      <div
        className={['app', menuOpen && 'menu-open', assistantOpen && 'assistant-open']
          .filter(Boolean)
          .join(' ')}
      >
        <aside className="sidebar" aria-label={t('menu')} inert={pageInert}>
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
              const links = section.links.filter((l) => canSee(me, l));
              if (links.length === 0) return null;
              const { title } = section;
              // A section holding the current page never folds.
              const open = !title || !folded.has(title) || links.some((l) => isActive(l.href));
              return (
                <div key={title ?? index} className="nav-section">
                  {title && (
                    <button
                      type="button"
                      className="nav-title"
                      aria-expanded={open}
                      onClick={() => toggleSection(title)}
                    >
                      <span>{t(title)}</span>
                      {icons.chevron}
                    </button>
                  )}
                  {open &&
                    links.map((l) => (
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
        <div className="main" inert={pageInert}>
          <header className="topbar">
            <button
              type="button"
              className="icon-button menu-button"
              aria-label={t('menu')}
              onClick={() => setMenuOpen(true)}
            >
              {icons.menu}
            </button>
            <div className="topbar-spacer" />
            <div className="topbar-actions">
              <AlertsBell />
              {me.assistantUrl && me.assistantPanel ? (
                <button
                  ref={assistantToggle}
                  type="button"
                  className="ghost"
                  aria-expanded={assistantOpen}
                  aria-controls="assistant-panel"
                  onClick={toggleAssistant}
                >
                  {icons.assistant}
                  <span>{t('assistant')}</span>
                </button>
              ) : me.assistantUrl ? (
                <a
                  href={assistantPageUrl(me.assistantUrl, pathname)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="button ghost"
                >
                  {icons.assistant}
                  <span>{t('assistant')}</span>
                </a>
              ) : null}
              <Link href={pathname} locale={otherLocale} className="button ghost">
                {icons.globe}
                <span>{t('switchLocale')}</span>
              </Link>
              <button type="button" className="ghost" onClick={() => void signOut()}>
                {icons.signOut}
                <span>{t('signOut')}</span>
              </button>
            </div>
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
          </header>
          <main className="page">{children}</main>
        </div>
        {me.assistantUrl && me.assistantPanel && assistantLoaded ? (
          <AssistantPanel
            url={me.assistantUrl}
            pathname={pathname}
            open={assistantOpen}
            modal={pageInert}
            onClose={closeAssistant}
          />
        ) : null}
      </div>
    </MeContext>
  );
}
